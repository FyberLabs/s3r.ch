import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { blobConflict, type IdentityBlobClient } from "../../identity-blob.cjs";
import { directoryBlobClient } from "./directory-blob-client";
import { BlobLinkStore, openLinks } from "./link";

const require = createRequire(import.meta.url);
const { readBlobConfig, assertBlobReady, interpretBlobReply, createBlockingWorker } = require("../../identity-blob.cjs");
const { assertIdentityStorage: assertFromPreload } = require("../../identity-storage.cjs");
const WALLET = "0x1111111111111111111111111111111111111111";
const CONFIG = { account: "s3rchlinks", container: "identity", url: "https://s3rchlinks.blob.core.windows.net" };

class MemoryBlob implements IdentityBlobClient {
  text: string | null = null;
  etag = "";
  uploads = 0;
  conflicts = 0;
  reachable = true;
  hook: (() => void) | null = null;

  assertReachable(): void {
    if (!this.reachable) throw new Error("down");
  }

  download(): ReturnType<IdentityBlobClient["download"]> {
    if (!this.reachable) throw new Error("down");
    const snapshot = this.text === null
      ? ({ found: false as const })
      : ({ found: true as const, text: this.text, etag: this.etag });
    const hook = this.hook;
    this.hook = null;
    hook?.();
    return snapshot;
  }

  upload(_blobName: string, text: string, conditions: { ifMatch?: string; ifNoneMatch?: "*" }): { etag: string } {
    this.uploads += 1;
    if (conditions.ifNoneMatch === "*" && this.text !== null) {
      this.conflicts += 1;
      throw blobConflict();
    }
    if (conditions.ifMatch !== undefined && conditions.ifMatch !== this.etag) {
      this.conflicts += 1;
      throw blobConflict();
    }
    this.etag = String(this.uploads);
    this.text = text;
    return { etag: this.etag };
  }
}

describe("identity blob configuration", () => {
  it("requires an account name and a container name", () => {
    assert.throws(() => readBlobConfig({ NODE_ENV: "production" }), /S3RCH_IDENTITY_BLOB_ACCOUNT/);
    assert.throws(() => readBlobConfig({
      S3RCH_IDENTITY_BLOB_ACCOUNT: "S3RCH",
      S3RCH_IDENTITY_BLOB_CONTAINER: "identity",
    }), /S3RCH_IDENTITY_BLOB_ACCOUNT/);
    assert.throws(() => readBlobConfig({
      S3RCH_IDENTITY_BLOB_ACCOUNT: "s3rchlinks",
      S3RCH_IDENTITY_BLOB_CONTAINER: "a--b",
    }), /S3RCH_IDENTITY_BLOB_CONTAINER/);
    const env = {
      S3RCH_IDENTITY_BLOB_ACCOUNT: "s3rchlinks",
      S3RCH_IDENTITY_BLOB_CONTAINER: "s3rch-identity",
      AZURE_STORAGE_CONNECTION_STRING: "AccountKey=secret",
      AZURE_STORAGE_KEY: "secret",
      S3RCH_IDENTITY_LINKS: "/home/s3rch-identity/identity-links.json",
      WEBSITES_ENABLE_APP_SERVICE_STORAGE: "true",
    };
    const config = readBlobConfig(env);
    assert.deepEqual(config, {
      account: "s3rchlinks",
      container: "s3rch-identity",
      url: "https://s3rchlinks.blob.core.windows.net",
    });
    assert.equal(JSON.stringify(config).includes("secret"), false);
    assert.equal(JSON.stringify(config).includes("AccountKey"), false);
    assert.equal(JSON.stringify(config).includes("/home"), false);
  });

  it("the deploy pre-check requires the blob settings and not a home mount", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");
    assert.equal(workflow.includes("WEBSITES_ENABLE_APP_SERVICE_STORAGE"), false);
    assert.equal(workflow.includes("S3RCH_IDENTITY_STORAGE_ROOT"), false);
    assert.match(workflow, /S3RCH_IDENTITY_BLOB_ACCOUNT/);
    assert.match(workflow, /S3RCH_IDENTITY_BLOB_CONTAINER/);
    const script = new URL("../../scripts/require-identity-blob-settings.py", import.meta.url);
    const dir = mkdtempSync(join(tmpdir(), "s3rch-blob-settings-"));
    const file = join(dir, "settings.json");
    const run = (items: { name: string; value: string }[]) => {
      writeFileSync(file, JSON.stringify(items));
      return spawnSync("python3", [script.pathname, file], { encoding: "utf8" });
    };
    try {
      const ok = run([
        { name: "S3RCH_IDENTITY_BLOB_ACCOUNT", value: "s3rchlinks" },
        { name: "S3RCH_IDENTITY_BLOB_CONTAINER", value: "s3rch-identity" },
      ]);
      assert.equal(ok.status, 0, ok.stderr);
      const missing = run([{ name: "WEBSITES_ENABLE_APP_SERVICE_STORAGE", value: "true" }]);
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /S3RCH_IDENTITY_BLOB_ACCOUNT/);
      assert.equal(missing.stderr.includes("s3rchlinks"), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("startup fails when blob storage is unreachable and creates an empty document when the blob is missing", () => {
    assert.throws(() => assertBlobReady(CONFIG, {
      assertReachable() { throw new Error("nope"); },
      download() { throw new Error("nope"); },
      upload() { throw new Error("nope"); },
    }), /unreachable/);
    assert.throws(() => assertBlobReady(CONFIG, {
      assertReachable() {
        throw new Error("s3r.ch: identity blob storage refused access. Assign the Storage Blob Data Contributor role to the app identity.");
      },
      download() { throw new Error("nope"); },
      upload() { throw new Error("nope"); },
    }), /Storage Blob Data Contributor/);

    const created = new MemoryBlob();
    assertBlobReady(CONFIG, created);
    assert.equal(created.text, JSON.stringify({ v: 1, people: [] }));

    const invalid = new MemoryBlob();
    invalid.text = "{";
    invalid.etag = "1";
    assert.throws(() => assertBlobReady(CONFIG, invalid), /invalid/);
    assert.equal(invalid.text, "{");
    assert.equal(invalid.uploads, 0);

    const raced = new MemoryBlob();
    raced.upload = () => {
      raced.text = JSON.stringify({ v: 1, people: [] });
      raced.etag = "2";
      throw blobConflict();
    };
    assertBlobReady(CONFIG, raced);
    assert.equal(raced.text, JSON.stringify({ v: 1, people: [] }));
  });

  it("startup uses the same probe the process entry uses", () => {
    const env = {
      NODE_ENV: "production",
      S3RCH_IDENTITY_BLOB_ACCOUNT: "s3rchlinks",
      S3RCH_IDENTITY_BLOB_CONTAINER: "identity",
    };
    assert.throws(() => assertFromPreload(env, () => ({
      assertReachable() { throw new Error("down"); },
      download() { throw new Error("down"); },
      upload() { throw new Error("down"); },
    })), /unreachable/);
    let ready = false;
    assertFromPreload(env, () => ({
      assertReachable() { ready = true; },
      download() { return { found: true, text: JSON.stringify({ v: 1, people: [] }), etag: "1" }; },
      upload() { throw new Error("should not write"); },
    }));
    assert.equal(ready, true);
  });

  it("maps a conditional-write rejection to a conflict", () => {
    assert.throws(() => interpretBlobReply({ ok: false, code: "blob-conflict" }), (error: unknown) => {
      return !!error && typeof error === "object" && (error as { code?: string }).code === "blob-conflict";
    });
    assert.throws(() => interpretBlobReply({ ok: false, reason: "forbidden" }), /Storage Blob Data Contributor/);
  });
});

describe("identity blob documents", () => {
  it("a second process reads a link written by the first", () => {
    const dir = mkdtempSync(join(tmpdir(), "s3rch-blob-"));
    const moduleUrl = new URL("./link.ts", import.meta.url).href;
    const clientUrl = new URL("./directory-blob-client.ts", import.meta.url).href;
    const tsx = require.resolve("tsx");
    const run = (program: string, cwd: string) => {
      const result = spawnSync(process.execPath, ["--import", tsx, "--input-type=module", "-e", `
        import { BlobLinkStore, openLinks } from ${JSON.stringify(moduleUrl)};
        import { directoryBlobClient } from ${JSON.stringify(clientUrl)};
        const links = openLinks(new BlobLinkStore(directoryBlobClient(${JSON.stringify(dir)})));
        ${program}
      `], { cwd, env: { ...process.env, NODE_ENV: "test" }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    try {
      const first = join(dir, "old-container");
      const replacement = join(dir, "new-container");
      mkdirSync(first);
      mkdirSync(replacement);
      run(`if (links.link({wallet:${JSON.stringify(WALLET)}, sub:"kc-restart", idp:"github"}).denied) process.exit(1);`, first);
      run(`if (links.ownerForOAuth("kc-restart") !== ${JSON.stringify(WALLET)}) process.exit(1);`, replacement);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("retries a conditional write and keeps both updates", () => {
    const blob = new MemoryBlob();
    const first = openLinks(new BlobLinkStore(blob));
    const second = openLinks(new BlobLinkStore(blob));
    assert.deepEqual(first.link({ wallet: WALLET, sub: "one", idp: "github" }), { owner: WALLET });
    blob.hook = () => {
      const sneaky = openLinks(new BlobLinkStore(blob));
      assert.deepEqual(sneaky.link({ wallet: WALLET, sub: "two", idp: "google" }), { owner: WALLET });
    };
    assert.deepEqual(second.link({ wallet: WALLET, sub: "three", idp: "microsoft" }), { owner: WALLET });
    assert.equal(blob.conflicts > 0, true);
    const saved = JSON.parse(blob.text || "{}") as { people: { handles: { kind: string; sub?: string }[] }[] };
    const subs = saved.people[0].handles.filter((handle) => handle.kind === "oauth").map((handle) => handle.sub);
    assert.deepEqual(subs.sort(), ["one", "three", "two"]);
  });

  it("does not recreate a disappeared production blob", () => {
    const moduleUrl = new URL("./link.ts", import.meta.url).href;
    const tsx = require.resolve("tsx");
    const program = `
      import assert from "node:assert/strict";
      const { BlobLinkStore, openLinks, useLinkStore } = await import(${JSON.stringify(moduleUrl)});
      const { blobConflict } = await import(${JSON.stringify(new URL("../../identity-blob.cjs", import.meta.url).href)});
      const blob = {
        text: JSON.stringify({ v: 1, people: [] }),
        etag: "1",
        uploads: 0,
        reachable: true,
        assertReachable() {},
        download() {
          if (!blob.reachable) throw new Error("down");
          if (blob.text === null) return { found: false };
          return { found: true, text: blob.text, etag: blob.etag };
        },
        upload() { blob.uploads += 1; throw blobConflict(); },
      };
      const store = new BlobLinkStore(blob);
      useLinkStore(store);
      const links = openLinks(store);
      assert.equal(links.ownerForWallet("${WALLET}"), "${WALLET}");
      blob.text = null;
      process.env.IDENTITY_SESSION_SECRET = "production-fixture-identity-secret-32-characters";
      const { signSessionToken } = await import(${JSON.stringify(new URL("./session.ts", import.meta.url).href)});
      const { sessionCookieName } = await import(${JSON.stringify(new URL("./cookies.ts", import.meta.url).href)});
      const token = await signSessionToken({ address: "${WALLET}", chainId: 1 }, process.env.IDENTITY_SESSION_SECRET);
      const request = new Request("https://s3rch.test/api", { headers: { cookie: sessionCookieName(true) + "=" + token } });
      const sessionRoute = await import(${JSON.stringify(new URL("../../app/api/identity/session/route.ts", import.meta.url).href)});
      assert.equal((await sessionRoute.GET(request)).status, 503);
      const outboundRoute = await import(${JSON.stringify(new URL("../../app/api/outbound/route.ts", import.meta.url).href)});
      assert.equal((await outboundRoute.GET(request)).status, 503);
      assert.equal(links.ownerForWallet("${WALLET}"), null);
      assert.equal(links.link({ wallet: "${WALLET}", sub: "missing", idp: null }).denied, true);
      assert.equal(blob.uploads, 0);
      blob.text = JSON.stringify({ v: 1, people: [] });
      blob.reachable = false;
      assert.equal(links.ownerForWallet("${WALLET}"), null);
      assert.equal(links.link({ wallet: "${WALLET}", sub: "unreachable", idp: null }).denied, true);
      assert.equal(blob.uploads, 0);
      assert.equal(blob.text, JSON.stringify({ v: 1, people: [] }));
    `;
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
    delete env.S3RCH_IDENTITY_BLOB_ACCOUNT;
    delete env.S3RCH_IDENTITY_BLOB_CONTAINER;
    const result = spawnSync(process.execPath, ["--import", tsx, "--input-type=module", "-e", program], {
      env, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  });

  it("blocks on a worker reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s3rch-blob-worker-"));
    const fixture = join(dir, "worker.cjs");
    writeFileSync(fixture, `
      const { parentPort } = require("node:worker_threads");
      let port, shared;
      function reply(message) {
        port.postMessage(message);
        Atomics.store(shared, 0, 1);
        Atomics.notify(shared, 0);
      }
      parentPort.on("message", (msg) => {
        if (msg.op === "init") {
          port = msg.port;
          shared = new Int32Array(msg.shared);
          reply({ ok: true });
          return;
        }
        reply({ ok: true, echo: msg.n });
      });
    `);
    const bridge = createBlockingWorker(fixture, {}, 3000);
    try {
      assert.equal(bridge.call({ n: 7 }).echo, 7);
    } finally {
      await bridge.terminate();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
