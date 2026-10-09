import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { FileLinkStore, openLinks } from "./link";

const { identityLinkPath, mountedRoot } = createRequire(import.meta.url)("../../identity-storage.cjs");
const WALLET = "0x1111111111111111111111111111111111111111";

describe("identity storage configuration", () => {
  it("refuses missing or container-local production paths", () => {
    for (const env of [
      { NODE_ENV: "production" },
      { NODE_ENV: "production", S3RCH_IDENTITY_LINKS: "/app/data/links.json" },
      { NODE_ENV: "production", S3RCH_IDENTITY_STORAGE_ROOT: "/home", S3RCH_IDENTITY_LINKS: "/app/data/links.json" },
      { NODE_ENV: "production", S3RCH_IDENTITY_STORAGE_ROOT: "/home", S3RCH_IDENTITY_LINKS: "/home/../app/links.json" },
    ]) assert.throws(() => identityLinkPath(env));
    assert.equal(identityLinkPath({ NODE_ENV: "production", S3RCH_IDENTITY_STORAGE_ROOT: "/home", S3RCH_IDENTITY_LINKS: "/home/s3rch/links.json" }), "/home/s3rch/links.json");
  });

  it("the production entrypoint refuses to start without durable configuration", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
    delete env.S3RCH_IDENTITY_LINKS;
    delete env.S3RCH_IDENTITY_STORAGE_ROOT;
    const result = spawnSync(process.execPath, ["-r", "./gun-preload.cjs", "-e", "process.stdout.write('started')"], {
      cwd: new URL("../../", import.meta.url), env, encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /configure S3RCH_IDENTITY_STORAGE_ROOT/);
    assert.equal(result.stdout.includes("started"), false);
  });

  it("requires the named root to be a mount and rejects memory/container layers", () => {
    assert.equal(mountedRoot("/home", "1 2 0:1 / / rw - overlay overlay rw"), false);
    assert.equal(mountedRoot("/home", "1 2 0:1 / /home rw - tmpfs tmpfs rw"), false);
    assert.equal(mountedRoot("/home", "1 2 0:1 / /home rw - cifs storage rw"), true);
  });
});

describe("durable account links", () => {
  it("a replacement process in a different checkout reads a previously saved link", () => {
    const volume = mkdtempSync(join(tmpdir(), "s3rch-volume-"));
    const file = join(volume, "links.json");
    const moduleUrl = new URL("./link.ts", import.meta.url).href;
    const tsx = createRequire(import.meta.url).resolve("tsx");
    const run = (program: string, cwd: string) => {
      const result = spawnSync(process.execPath, ["--import", tsx, "--input-type=module", "-e", `import { linkLoginPaths, ownerForOAuth } from ${JSON.stringify(moduleUrl)}; ${program}`], {
        cwd, env: { ...process.env, NODE_ENV: "test", S3RCH_IDENTITY_LINKS: file }, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    };
    try {
      const first = join(volume, "old-container");
      const replacement = join(volume, "new-container");
      mkdirSync(first); mkdirSync(replacement);
      run(`if (linkLoginPaths({wallet:${JSON.stringify(WALLET)}, sub:"kc-restart", idp:"github"}).denied) process.exit(1);`, first);
      run(`if (ownerForOAuth("kc-restart") !== ${JSON.stringify(WALLET)}) process.exit(1);`, replacement);
      assert.equal(statSync(file).mode & 0o777, 0o600);
    } finally { rmSync(volume, { recursive: true, force: true }); }
  });

  it("a competing writer cannot overwrite links while another process holds the lock", () => {
    const volume = mkdtempSync(join(tmpdir(), "s3rch-volume-"));
    const file = join(volume, "links.json");
    try {
      const links = openLinks(new FileLinkStore(file));
      assert.deepEqual(links.link({ wallet: WALLET, sub: "original", idp: "github" }), { owner: WALLET });
      const before = readFileSync(file, "utf8");
      mkdirSync(`${file}.lock`);
      assert.deepEqual(links.link({ wallet: WALLET, sub: "competing", idp: "google" }), { denied: true, reason: "store-unreadable" });
      assert.equal(readFileSync(file, "utf8"), before);
      rmSync(`${file}.lock`, { recursive: true });
      assert.deepEqual(links.link({ wallet: WALLET, sub: "competing", idp: "google" }), { owner: WALLET });
      assert.equal(links.ownerForOAuth("original"), WALLET);
    } finally { rmSync(volume, { recursive: true, force: true }); }
  });
});


describe("production identity loss", () => {
  it("does not recreate a disappeared store or accept a lost mount", () => {
    const volume = mkdtempSync(join(tmpdir(), "s3rch-production-"));
    const file = join(volume, "links.json");
    const moduleUrl = new URL("./link.ts", import.meta.url).href;
    const tsx = createRequire(import.meta.url).resolve("tsx");
    const program = `
      import fs from "node:fs";
      import assert from "node:assert/strict";
      const read = fs.readFileSync;
      let mounted = true;
      fs.readFileSync = function(path, ...args) {
        if (path === "/proc/self/mountinfo") return mounted ? "1 2 0:1 / ${volume} rw - cifs durable rw" : "";
        return read.call(this, path, ...args);
      };
      const {FileLinkStore, openLinks} = await import(${JSON.stringify(moduleUrl)});
      const file = ${JSON.stringify(file)};
      fs.writeFileSync(file, JSON.stringify({v:1,people:[]}));
      const store = new FileLinkStore(file);
      const links = openLinks(store);
      assert.equal(links.ownerForWallet("${WALLET}"), "${WALLET}");
      fs.unlinkSync(file);
      process.env.IDENTITY_SESSION_SECRET = "production-fixture-identity-secret-32-characters";
      const {signSessionToken} = await import(${JSON.stringify(new URL("./session.ts", import.meta.url).href)});
      const {sessionCookieName} = await import(${JSON.stringify(new URL("./cookies.ts", import.meta.url).href)});
      const token = await signSessionToken({address:"${WALLET}",chainId:1},process.env.IDENTITY_SESSION_SECRET);
      const request = new Request("https://s3rch.test/api", {headers:{cookie:sessionCookieName(true)+"="+token}});
      const sessionRoute = await import(${JSON.stringify(new URL("../../app/api/identity/session/route.ts", import.meta.url).href)});
      assert.equal((await sessionRoute.GET(request)).status,503);
      const outboundRoute = await import(${JSON.stringify(new URL("../../app/api/outbound/route.ts", import.meta.url).href)});
      assert.equal((await outboundRoute.GET(request)).status,503);
      assert.equal(links.ownerForWallet("${WALLET}"), null);
      assert.equal(links.link({wallet:"${WALLET}",sub:"missing",idp:null}).denied, true);
      assert.equal(fs.existsSync(file), false);
      fs.writeFileSync(file, JSON.stringify({v:1,people:[]}));
      mounted = false;
      assert.equal(links.ownerForWallet("${WALLET}"), null);
      assert.equal(links.link({wallet:"${WALLET}",sub:"unmounted",idp:null}).denied, true);
      assert.deepEqual(JSON.parse(read(file,"utf8")), {v:1,people:[]});
    `;
    try {
      const result = spawnSync(process.execPath, ["--import", tsx, "--input-type=module", "-e", program], {
        env: {...process.env, NODE_ENV:"production", S3RCH_IDENTITY_STORAGE_ROOT:volume, S3RCH_IDENTITY_LINKS:file}, encoding:"utf8"
      });
      assert.equal(result.status, 0, result.stderr);
    } finally { rmSync(volume,{recursive:true,force:true}); }
  });

  it("startup uses the same complete account schema as request-time reads", () => {
    const {parseLinkFile} = createRequire(import.meta.url)("../../identity-link-schema.cjs");
    for (const people of [
      [{owner:"invalid",handles:[]}],
      [{owner:WALLET,handles:[{kind:"oauth",sub:"kc",idp:null}]}],
      [{owner:WALLET,handles:[{kind:"wallet",address:WALLET},{kind:"wallet",address:WALLET}]}],
      [{owner:WALLET,handles:[{kind:"wallet",address:WALLET},{kind:"oauth",sub:"kc",idp:"invalid"}]}],
    ]) assert.equal(parseLinkFile({v:1,people}).ok,false);
  });
});
