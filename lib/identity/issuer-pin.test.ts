import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import { oauthPkceCookieName } from "./cookies";
import { FileLinkStore, openLinks, parseLinkFile, useLinkStore } from "./link";
import { beginOAuth, finishOAuth } from "./oauth";
import { approvedIssuerMove } from "./providers";

const OLD = "https://login.partner.example/realms/main";
const NEW = "https://login.other.example/realms/main";

function env(issuer: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    S3RCH_LOGIN_PROVIDERS: JSON.stringify([{ id: "partner", kind: "oidc", issuer, clientId: "s3rch" }]),
    NODE_ENV: "test",
    ...extra,
  };
}

async function login(e: Record<string, string>, issuer: string): Promise<string> {
  const started = await beginOAuth(new Request("http://127.0.0.1:3000/api/identity/oauth/start?provider=partner"), e);
  const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const pkce = (started.headers.getSetCookie().find((row) => row.startsWith(`${oauthPkceCookieName(false)}=`)) ?? "").split(";")[0];
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const idToken = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(issuer)
    .setAudience("s3rch")
    .setSubject("user-7")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const finished = await finishOAuth(
    new Request(`http://127.0.0.1:3000/api/identity/oauth/callback?code=c&state=${state}`, { headers: { cookie: pkce } }),
    e,
    { key: publicKey, fetchImpl: async () => Response.json({ id_token: idToken }) },
  );
  return finished.headers.get("location") ?? "";
}

describe("login provider issuer pinning", () => {
  let file = "";
  const quiet = { error: console.error, warn: console.warn, info: console.info };
  before(() => {
    console.error = console.warn = console.info = () => {};
  });
  after(() => {
    Object.assign(console, quiet);
    useLinkStore(null);
  });
  function fresh(): void {
    file = path.join(mkdtempSync(path.join(tmpdir(), "s3rch-pin-")), "links.json");
    useLinkStore(new FileLinkStore(file));
  }
  function pins(): Record<string, string> | undefined {
    return JSON.parse(readFileSync(file, "utf8")).providerIssuers;
  }

  it("pins the issuer on first use", async () => {
    fresh();
    assert.notEqual(await login(env(OLD), OLD), "/feed?oauth=denied");
    assert.deepEqual(pins(), { partner: OLD });
    assert.notEqual(await login(env(OLD), OLD), "/feed?oauth=denied");
  });

  it("refuses a provider whose configured issuer changed", async () => {
    fresh();
    await login(env(OLD), OLD);
    assert.equal(await login(env(NEW), NEW), "/feed?oauth=denied");
    assert.deepEqual(pins(), { partner: OLD });
  });

  it("ignores an approval for a different issuer or provider", async () => {
    fresh();
    await login(env(OLD), OLD);
    const wrong = { S3RCH_LOGIN_PROVIDER_ISSUER_MOVE: "partner:https://elsewhere.example,other:" + NEW };
    assert.equal(await login(env(NEW, wrong), NEW), "/feed?oauth=denied");
    assert.deepEqual(pins(), { partner: OLD });
  });

  it("moves the pin when the operator approves the new issuer", async () => {
    fresh();
    await login(env(OLD), OLD);
    const move = { S3RCH_LOGIN_PROVIDER_ISSUER_MOVE: `partner:${NEW}/` };
    assert.notEqual(await login(env(NEW, move), NEW), "/feed?oauth=denied");
    assert.deepEqual(pins(), { partner: NEW });
    // The approval only moves to the named issuer; the old one is now refused.
    assert.equal(await login(env(OLD, move), OLD), "/feed?oauth=denied");
    assert.notEqual(await login(env(NEW), NEW), "/feed?oauth=denied");
  });

  it("keeps account keys and existing links unchanged", () => {
    fresh();
    const links = openLinks(new FileLinkStore(file));
    const linked = links.link({ wallet: "0x" + "1".repeat(40), sub: "f81d4fae-7dec-11d0-a765-00a0c91e6bf6", idp: null });
    assert.ok("owner" in linked);
    assert.deepEqual(links.checkProviderIssuer("panopticon", OLD), { ok: true, pinned: "first-use" });
    assert.equal(links.ownerForOAuth("f81d4fae-7dec-11d0-a765-00a0c91e6bf6"), linked.owner);
  });

  it("validates stored pins and parses the approval setting", () => {
    assert.ok(parseLinkFile({ v: 1, people: [], providerIssuers: { partner: OLD } }).ok);
    assert.ok(!parseLinkFile({ v: 1, people: [], providerIssuers: { "Bad Id": OLD } }).ok);
    assert.ok(!parseLinkFile({ v: 1, people: [], providerIssuers: { partner: 5 } }).ok);
    assert.equal(approvedIssuerMove({ S3RCH_LOGIN_PROVIDER_ISSUER_MOVE: `partner:${NEW}` }, "partner"), NEW);
    assert.equal(approvedIssuerMove({ S3RCH_LOGIN_PROVIDER_ISSUER_MOVE: "partner:http://x.example" }, "partner"), null);
    assert.equal(approvedIssuerMove({}, "partner"), null);
  });
});
