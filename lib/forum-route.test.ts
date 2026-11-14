import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createECDH } from "node:crypto";
import { SignJWT } from "jose";
import { GET, POST } from "../app/api/forum/route";
import { signSessionToken } from "./identity/session";
import { signBackupSession } from "./identity/oauth";
function principal(scalar: number) {
  const ecdh = createECDH("prime256v1"), bytes = Buffer.alloc(32); bytes[31] = scalar;
  ecdh.setPrivateKey(bytes); const pub = ecdh.getPublicKey();
  return `${pub.subarray(1, 33).toString("base64url")}.${pub.subarray(33).toString("base64url")}`;
}
const ALICE = principal(121), BOB = principal(122);
const secret = "forum-route-unit-secret-".repeat(3);
const origin = "https://s3r.ch";
async function cookie(principal: string, credential: string) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ sub: principal, iss: origin, aud: origin, iat: now, exp: now + 300, jti: "a".repeat(64) })
    .setProtectedHeader({ alg: "HS256", typ: "s3rch-identity-session-v1" }).sign(new TextEncoder().encode(secret));
  return `__Host-s3rch-squad-session=${token}; credential-metadata=${credential}`;
}
function req(cookie = "", headers: Record<string, string> = {}) {
  return new Request(origin + "/api/forum", { headers: { cookie, ...headers } });
}
async function post(cookie: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await POST(new Request(origin + "/api/forum", { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
}
async function read(cookie: string) {
  const response = await GET(req(cookie));
  return { status: response.status, body: await response.json() };
}
test("forum grants and revocation use the SEA principal across credential metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "s3rch-forum-route-"));
  const before = { forum: process.env.S3RCH_FORUM, secret: process.env.IDENTITY_SESSION_SECRET };
  process.env.S3RCH_FORUM = join(dir, "forum.json"); process.env.IDENTITY_SESSION_SECRET = secret;
  try {
    const alice = await cookie(ALICE, "wallet-a"), linked = await cookie(ALICE, "oidc-b"), bob = await cookie(BOB, "wallet-c");
    assert.equal((await GET(req())).status, 401);
    for (const credential of [
      `s3rch-session=${await signSessionToken({ address: "0x" + "a".repeat(40), chainId: 1 }, secret)}`,
      `s3rch-oauth-session=${await signBackupSession({ sub: "oidc-subject", idp: "github" }, secret)}`,
      "__Host-s3rch-squad-session=invalid",
    ]) assert.equal((await GET(req(credential))).status, 401);
    const registered = await post(alice, { action: "register", label: "ledger", entropy: "rt01" });
    assert.equal(registered.status, 200);
    const botId = registered.body.bot.id;
    assert.ok(botId.startsWith(`s3rch:bot:${ALICE}:`));
    assert.equal((await post(linked, { action: "post", botId, body: "private", entropy: "rt02", nowSeconds: 1700000001 })).status, 200);
    assert.equal((await read(linked)).body.channel.owner, ALICE);
    assert.equal((await read(bob)).body.messages.length, 0);
    assert.equal((await post(linked, { action: "invite", guest: BOB })).status, 200);
    assert.equal((await read(bob)).body.shared[0].channel.owner, ALICE);
    assert.equal((await post(alice, { action: "uninvite", guest: BOB })).status, 200);
    assert.deepEqual((await read(bob)).body.shared, []);
    assert.equal((await post(alice, { action: "invite", guest: "0x" + "a".repeat(40) })).status, 400);
    assert.equal((await post(alice, { action: "token" })).status, 410);
    const malformed = await POST(new Request(origin + "/api/forum", { method: "POST", headers: { cookie: alice }, body: "{" }));
    assert.equal(malformed.status, 400);
    const delegatedHeaders: Record<string, string>[] = [{ authorization: "Bearer agent-token" }, { "x-s3rch-forum-token": "agent-token" }, { "x-s3rch-forum-token": "" }];
    for (const headers of delegatedHeaders) {
      assert.equal((await GET(req(alice, headers))).status, 401);
      for (const action of ["post", "invite", "token", "desktop"])
        assert.equal((await post(alice, { action }, headers)).status, 401);
    }
    process.env.IDENTITY_SESSION_SECRET = "wrong-secret-".repeat(4);
    assert.equal((await GET(req(alice))).status, 401);
  } finally {
    if (before.forum === undefined) delete process.env.S3RCH_FORUM; else process.env.S3RCH_FORUM = before.forum;
    if (before.secret === undefined) delete process.env.IDENTITY_SESSION_SECRET; else process.env.IDENTITY_SESSION_SECRET = before.secret;
    rmSync(dir, { recursive: true, force: true });
  }
});
