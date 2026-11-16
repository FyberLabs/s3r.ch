// Native cryptographic contracts run in CI only. Local coverage uses terminal-run.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { generateKeyPair, SignJWT, decodeJwt } from "jose";
import { createIdentitySessions } from "./sea-session";
import { createIdentityTokenVerifier } from "./sea-session-verifier";
import { signSessionToken, readSessionToken } from "./session";
import { createExperimentPrivacy } from "../experiment-privacy";
import { signForumRecord } from "../forum-sign";
import { withTerminalRun, type TerminalRunAuthority } from "./terminal-run";
import type { SeaPair } from "./sea";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
const secret = "s".repeat(40), origin = "https://s3r.ch", now = 1700000060;
function fixture() {
  const state = { run: "1-1-suite", active: true, completed: 0 };
  const authority: TerminalRunAuthority = {
    async admit() { return { binding: { run: state.run, generation: "a".repeat(64) }, operation: "12345678-1234-1234-1234-123456789abc" }; },
    async active() { return state.active; }, async authorizeToken() { return true; },
    async complete() { state.completed++; },
  };
  return { state, run: <T>(work: () => Promise<T>) => withTerminalRun({} as Request, authority, work, value => value !== null) };
}
test("actual SEA issuer and verifier bind challenges and sessions and refuse old-run replay", async () => {
  const h = fixture(), pair = await sea.pair();
  const used = new Set<string>();
  const input = { origin, secret, clock: () => now, consume: async (id: string) => { if (used.has(id)) return false; used.add(id); return true; } };
  const sessions = createIdentitySessions(input), reader = createIdentityTokenVerifier(input);
  const legacy = await sessions.challenge(pair.pub);
  await h.run(async () => {
    assert.equal(await sessions.exchange(legacy, (await signForumRecord(legacy, pair))!), null);
  });
  const challenge = await h.run(() => sessions.challenge(pair.pub));
  const signed = (await signForumRecord(challenge, pair))!;
  const token = await h.run(() => sessions.exchange(challenge, signed)); assert.ok(token);
  assert.deepEqual(decodeJwt(token).nightly_run, { run: h.state.run, generation: "a".repeat(64) });
  assert.deepEqual(await h.run(() => reader.authenticate(token)), { key: pair.pub });
  assert.equal(await reader.authenticate(token), null); // An unconfigured verifier cannot ignore the binding.
  h.state.run = "2-1-suite";
  assert.equal(await h.run(() => reader.authenticate(token)), null);
  h.state.run = "1-1-suite"; h.state.active = false;
  await assert.rejects(h.run(() => reader.authenticate(token)));
});
test("real consent/display and wallet cookies require their original admitted run", async () => {
  const h = fixture(), privacy = createExperimentPrivacy({ tenant: "tenant", origin, secret: Buffer.alloc(32, 1), clock: () => now });
  const legacy = await privacy.consent();
  assert.equal(await h.run(() => privacy.privacy(legacy)), null);
  const cookie = await h.run(() => privacy.consent());
  assert.ok(await h.run(() => privacy.privacy(cookie)));
  assert.equal(await privacy.privacy(cookie), null);
  const wallet = await h.run(() => signSessionToken({ address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", chainId: 1 }, secret, now * 1000));
  assert.ok(await h.run(() => readSessionToken(wallet, secret, now * 1000)));
  await assert.rejects(readSessionToken(wallet, secret, now * 1000));
  h.state.run = "new-run";
  assert.equal(await h.run(() => privacy.privacy(cookie)), null);
  await assert.rejects(h.run(() => readSessionToken(wallet, secret, now * 1000)));
});

test("actual device callback refuses an old provider run and preserves original JWE binding", async () => {
  const { deviceConfig } = await import("./device-config");
  const { devicePersonOAuth, readDevicePerson } = await import("./device-person");
  const { devicePendingCookie, devicePersonCookie } = await import("./device-cookies");
  const h = fixture();
  const scope = { sourceOrigin: origin, destinationOrigin: origin, application: "s3r.ch", tenant: "11111111-1111-1111-1111-111111111111", audience: "device" };
  const env = { IDENTITY_SESSION_SECRET: secret, S3RCH_OAUTH_ISSUER: "https://issuer.example/realm", S3RCH_DEVICE_TRANSFER_CONFIG: JSON.stringify({ v: 1, scope, auth: "https://auth.example/auth/sea-device-link/v1/", acl: "https://acl.example/api/v1/acl/sociacl/device-transfer/", provider: "panopticon" }) };
  const config = deviceConfig(origin, env)!;
  const cookie = (response: Response, name: string) => response.headers.getSetCookie().find(value => value.startsWith(name + "=") && !value.startsWith(name + "=;"))?.split(";")[0] ?? "";
  const start = await h.run(() => devicePersonOAuth(new Request(origin), "authorize", config, origin, env, { now: () => now }));
  const url = new URL(start.headers.get("location")!);
  const callback = new Request(origin + "/api/identity/device/callback?code=code&state=" + url.searchParams.get("state"), { headers: { Cookie: cookie(start, devicePendingCookie) } });
  const keys = await generateKeyPair("ES256");
  async function exchange(run: string) {
    const idToken = await new SignJWT({ nonce: url.searchParams.get("nonce"), nightly_run: { run, generation: "a".repeat(64) } })
      .setProtectedHeader({ alg: "ES256" }).setIssuer(config.provider.issuer).setAudience(config.provider.clientId).setSubject("person").setIssuedAt(now).setExpirationTime(now + 600).sign(keys.privateKey);
    return h.run(() => devicePersonOAuth(callback, "callback", config, origin, env, { now: () => now, verifyKey: keys.publicKey,
      fetch: async () => Response.json({ id_token: idToken, access_token: "fixture-bearer", token_type: "Bearer" }) }));
  }
  assert.match((await exchange("old-run")).headers.get("location")!, /unavailable/);
  const done = await exchange(h.state.run), stored = cookie(done, devicePersonCookie); assert.ok(stored);
  const request = new Request(origin, { headers: { Cookie: stored } });
  assert.equal((await h.run(() => readDevicePerson(request, config, origin, env, now)))?.subject, "person");
  assert.equal(await readDevicePerson(request, config, origin, env, now), null);
  h.state.run = "next-run";
  assert.equal(await h.run(() => readDevicePerson(request, config, origin, env, now)), null);
});
