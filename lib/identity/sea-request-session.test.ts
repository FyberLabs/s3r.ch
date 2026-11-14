import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { SignJWT } from "jose";
import { createIdentitySessions } from "./sea-session";
import { createIdentityTokenVerifier } from "./sea-session-verifier";
import { readSeaRequestSession } from "./sea-request-session";
import { signSessionToken } from "./session";
import { signForumRecord } from "../forum-sign";
import { sessionGatedAllocate } from "../turn-allocate";
import { PILOT_OWNER } from "../forum-squad-fixture";
import type { SeaPair } from "./sea";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
const secret = "s".repeat(40), now = 1800000000, origin = "https://s3r.ch";
const env = { NODE_ENV: "production", IDENTITY_SESSION_SECRET: secret };
const request = (token: string, url = origin, name = "__Host-s3rch-squad-session") =>
  new Request(url + "/api/turn/allocate", { headers: { cookie: `${name}=${token}` } });
async function setup() {
  const pair = await sea.pair(), sessions = createIdentitySessions({ origin, secret, clock: () => now, consume: async () => true });
  const challenge = await sessions.challenge(pair.pub), signature = await signForumRecord(challenge, pair);
  const token = await sessions.exchange(challenge, signature!); assert.ok(token);
  return { pair, challenge, token };
}
test("TURN reads the existing issuer's SEA session without minting another token", async () => {
  const h = await setup();
  assert.deepEqual(await readSeaRequestSession(request(h.token), env, () => now), { key: h.pair.pub, expiresAt: (now+300)*1000 });
  const reader = createIdentityTokenVerifier({ origin, secret, clock: () => now });
  assert.deepEqual(await reader.authenticate(h.token), { key: h.pair.pub });
  assert.ok(!("challenge" in reader) && !("exchange" in reader));
  assert.equal(await reader.authenticate(h.challenge), null);
  assert.equal(await readSeaRequestSession(request(h.token), env, () => now + 300), null);
});
test("wallet, linked metadata, duplicate cookie, wrong origin and invalid secrets cannot grant TURN", async () => {
  const h = await setup(), wallet = await signSessionToken({ address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", chainId: 1 }, secret);
  for (const token of [wallet, h.challenge, h.token + "x", "x".repeat(4097)]) assert.equal(await readSeaRequestSession(request(token), env, () => now), null);
  for (const name of ["s3rch-session", "__Host-s3rch-startup-credential", "s3rch-squad-session"])
    assert.equal(await readSeaRequestSession(request(h.token, origin, name), env, () => now), null);
  for (const url of ["https://foreign.invalid", "https://test.s3r.ch", "http://s3r.ch"])
    assert.equal(await readSeaRequestSession(request(h.token, url), env, () => now), null);
  assert.equal(await readSeaRequestSession(request(h.token), { NODE_ENV: "production" }, () => now), null);
  assert.equal(await readSeaRequestSession(request(h.token), { ...env, IDENTITY_SESSION_SECRET: "x".repeat(40) }, () => now), null);
  assert.equal(await readSeaRequestSession(new Request(origin, { headers: { cookie: `__Host-s3rch-squad-session=${h.token}; __Host-s3rch-squad-session=${h.token}` } }), env, () => now), null);
  assert.equal(await readSeaRequestSession(new Request(origin), env, () => now), null);
});
test("malformed signed claims and public demo principals fail at the shared verifier", async () => {
  const h = await setup(), reader = createIdentityTokenVerifier({ origin, secret, clock: () => now });
  for (const override of [{ sub: "0x" + "a".repeat(40) }, { sub: PILOT_OWNER }, { exp: now + 301 }, { iat: now + 1 }, { jti: "short" }]) {
    const token = await new SignJWT({ sub: h.pair.pub, iss: origin, aud: origin, iat: now, exp: now + 300, jti: "a".repeat(64), ...override })
      .setProtectedHeader({ alg: "HS256", typ: "s3rch-identity-session-v1" }).sign(new TextEncoder().encode(secret));
    assert.equal(await reader.authenticate(token), null);
  }
  for (const input of [{ origin: "http://s3r.ch", secret }, { origin, secret: "short" }]) assert.throws(() => createIdentityTokenVerifier(input));
  assert.equal(await createIdentityTokenVerifier({ origin, secret, clock: () => NaN }).authenticate(h.token), null);
  await assert.rejects(reader.claims(h.token, "other", 300));
});
test("allocation refuses wallet/OIDC/demo labels before any provider or static fallback", async () => {
  for (const principal of [null, "0x" + "a".repeat(40), "oidc-subject", PILOT_OWNER]) {
    const result = await sessionGatedAllocate({ sessionPrincipal: principal, env: { S3RCH_TURN_URLS: "stun:stun.example.org" },
      fetchImpl: async () => { assert.fail("no provider call"); } });
    assert.equal(result.status, 401);
  }
});
