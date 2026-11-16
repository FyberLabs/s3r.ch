// Native signing/handler contracts: CI only, no network or real provider fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateKeyPair, SignJWT } from "jose";
import { signNonceToken, readNonceToken } from "./nonce";
import { signConfirmChallenge, readConfirmChallenge } from "./confirm";
import { signBackupSession, readBackupSession, verifyBackupIdToken } from "./oauth";
import { beginStartupOAuth, finishStartupOAuth, readStartupCredential } from "./startup-oauth";
import { parseStartupLoginConfig } from "./startup-login-config";
import { startupPendingName, startupCredentialName } from "./startup-login-cookies";
import { withTerminalRun, type TerminalRunAuthority } from "./terminal-run";
const secret = "s".repeat(40), address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
function fixture() {
  const state = { run: "1-1-suite", active: true };
  const authority: TerminalRunAuthority = {
    async admit() { return { binding: { run: state.run, generation: "a".repeat(64) }, operation: "12345678-1234-1234-1234-123456789abc" }; },
    async active() { return state.active; }, async authorizeToken() { return true; }, async complete() {},
  };
  return { state, run: <T>(work: () => Promise<T>) => withTerminalRun({} as Request, authority, work, () => true) };
}
test("backup OAuth, wallet nonce and confirmation cannot bypass original-run binding", async () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    { issue: () => signNonceToken("fixture-nonce", secret), read: (token: string) => readNonceToken(token, secret) },
    { issue: () => signConfirmChallenge({ address, kind: "email", targetHash: "target", codeHash: "code", iat: now, exp: now + 300 }, secret), read: (token: string) => readConfirmChallenge(token, secret) },
    { issue: () => signBackupSession({ sub: "provider-person", idp: null }, secret), read: (token: string) => readBackupSession(token, secret) },
  ];
  for (const c of cases) {
    const h = fixture(), legacy = await c.issue();
    await assert.rejects(h.run(() => c.read(legacy)));
    const current = await h.run(c.issue);
    assert.ok(await h.run(() => c.read(current)));
    await assert.rejects(c.read(current));
    h.state.run = "2-1-suite";
    await assert.rejects(h.run(() => c.read(current)));
    h.state.run = "1-1-suite"; h.state.active = false;
    await assert.rejects(h.run(() => c.read(current)));
    assert.ok(await c.read(legacy)); // Unconfigured unrelated flow remains patch-compatible.
  }
});
test("provider ID tokens are not relabelled by a new OAuth admission", async () => {
  const h = fixture(), keys = await generateKeyPair("ES256"), issuer = "https://provider.invalid", now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ nightly_run: { run: h.state.run, generation: "a".repeat(64) } })
    .setProtectedHeader({ alg: "ES256" }).setIssuer(issuer).setAudience("client").setSubject("provider-person").setIssuedAt(now).setExpirationTime(now + 300).sign(keys.privateKey);
  const read = () => verifyBackupIdToken(token, { issuer, key: keys.publicKey, clientId: "client" });
  assert.ok(await h.run(read));
  h.state.run = "2-1-suite";
  await assert.rejects(h.run(read));
  await assert.rejects(read());
});
function cookie(response: Response, name: string) {
  const value = response.headers.getSetCookie().filter(value => value.startsWith(name + "=")).at(-1);
  assert.ok(value); return value.split(";")[0];
}
test("startup pending and linked metadata credentials retain original run across callback", async () => {
  const h = fixture(), env = { NODE_ENV: "test", S3RCH_STARTUP_LOGIN_PROVIDER: "panopticon",
    S3RCH_STARTUP_AUTH_URL: "https://auth.example.invalid/auth/startup/identity",
    S3RCH_OAUTH_ISSUER: "https://startup.example.invalid/realms/isolated", S3RCH_OAUTH_CLIENT_ID: "s3rch-web" };
  const base = "http://127.0.0.1:3000", now = 1800000000000;
  const config = parseStartupLoginConfig(await readFile(new URL("./vectors/startup-deployment.json", import.meta.url)), env);
  const start = await h.run(() => beginStartupOAuth(new Request(base + "/api/identity/startup/start"), env, { config: async () => config, now }));
  const authorize = new URL(start.headers.get("location")!), pending = cookie(start, startupPendingName(false));
  const request = new Request(base + "/api/identity/oauth/callback?code=one-time&state=" + authorize.searchParams.get("state"), { headers: { cookie: pending } });
  const keys = await generateKeyPair("ES256");
  const idToken = await new SignJWT({ nonce: authorize.searchParams.get("nonce"), nightly_run: { run: h.state.run, generation: "a".repeat(64) } })
    .setProtectedHeader({ alg: "ES256" }).setIssuer(config.provider.issuer).setAudience(config.provider.clientId).setSubject("broker-person").setIssuedAt(now / 1000).setExpirationTime(now / 1000 + 300).sign(keys.privateKey);
  const identity = { ...config.binding, schema_version: 1, status: "resolved", permissions: [], person_id: "00000000-0000-4000-8000-000000000999", broker_subject: "broker-person" };
  let calls = 0;
  const deps = { config: async () => config, now, key: keys.publicKey, fetch: (async (url: RequestInfo | URL) => {
    calls++; return String(url) === config.provider.tokenEndpoint ? Response.json({ id_token: idToken, access_token: "synthetic-access" }) : Response.json(identity);
  }) as typeof fetch };
  h.state.run = "2-1-suite";
  assert.match((await h.run(() => finishStartupOAuth(request, env, deps))).headers.get("location")!, /denied/);
  assert.equal(calls, 0);
  h.state.run = "1-1-suite";
  const result = await h.run(() => finishStartupOAuth(request, env, deps));
  assert.equal(result.headers.get("location"), "/feed?startup=linked"); assert.equal(calls, 2);
  const saved = new Request(base + "/api/identity/startup/session", { headers: { cookie: cookie(result, startupCredentialName(false)) } });
  assert.ok(await h.run(() => readStartupCredential(saved, env, deps)));
  h.state.run = "2-1-suite";
  assert.equal(await h.run(() => readStartupCredential(saved, env, deps)), null);
  assert.equal(await readStartupCredential(saved, env, deps), null);
});
