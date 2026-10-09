import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { FileLinkStore, openLinks } from "./link";

const { identityLinkPath } = createRequire(import.meta.url)("../../identity-storage.cjs");
const WALLET = "0x1111111111111111111111111111111111111111";

describe("identity storage configuration", () => {
  it("does not use a container or home path in production", () => {
    for (const env of [
      { NODE_ENV: "production" },
      { NODE_ENV: "production", S3RCH_IDENTITY_LINKS: "/app/data/links.json" },
      { NODE_ENV: "production", S3RCH_IDENTITY_STORAGE_ROOT: "/home", S3RCH_IDENTITY_LINKS: "/home/s3rch-identity/identity-links.json" },
      {
        NODE_ENV: "production",
        S3RCH_IDENTITY_BLOB_ACCOUNT: "s3rchlinks",
        S3RCH_IDENTITY_BLOB_CONTAINER: "identity",
        S3RCH_IDENTITY_LINKS: "/app/data/links.json",
      },
    ]) assert.throws(() => identityLinkPath(env), /Azure Blob/);
    assert.equal(identityLinkPath({ NODE_ENV: "test" }, "/tmp/app"), "/tmp/app/data/identity-links.json");
    assert.equal(identityLinkPath({ NODE_ENV: "test", S3RCH_IDENTITY_LINKS: "/tmp/links.json" }), "/tmp/links.json");
  });

  it("the production entrypoint refuses to start without blob settings", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
    delete env.S3RCH_IDENTITY_BLOB_ACCOUNT;
    delete env.S3RCH_IDENTITY_BLOB_CONTAINER;
    delete env.S3RCH_IDENTITY_LINKS;
    delete env.S3RCH_IDENTITY_STORAGE_ROOT;
    const result = spawnSync(process.execPath, ["-r", "./gun-preload.cjs", "-e", "process.stdout.write('started')"], {
      cwd: new URL("../../", import.meta.url), env, encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /S3RCH_IDENTITY_BLOB_ACCOUNT/);
    assert.equal(result.stdout.includes("started"), false);
  });

  it("production does not write the development identity file", () => {
    const dir = mkdtempSync(join(tmpdir(), "s3rch-file-prod-"));
    const file = join(dir, "links.json");
    const moduleUrl = new URL("./link.ts", import.meta.url).href;
    const tsx = createRequire(import.meta.url).resolve("tsx");
    const program = `
      import { FileLinkStore, openLinks } from ${JSON.stringify(moduleUrl)};
      const links = openLinks(new FileLinkStore(${JSON.stringify(file)}));
      const result = links.link({ wallet: ${JSON.stringify(WALLET)}, sub: "nope", idp: "github" });
      if (!result.denied) process.exit(2);
    `;
    try {
      const result = spawnSync(process.execPath, ["--import", tsx, "--input-type=module", "-e", program], {
        env: { ...process.env, NODE_ENV: "production" }, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(file), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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


describe("production identity schema", () => {
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
