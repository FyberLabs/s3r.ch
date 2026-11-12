import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { generateKeyPair, SignJWT } from "jose";
import { beginStartupOAuth, finishStartupOAuth, readStartupCredential, hasStartupPending } from "./startup-oauth";
import { createStartupLinkedLogin } from "./startup-linked-login";
import { parseStartupLoginConfig } from "./startup-login-config";
import { startupPendingName, startupCredentialName } from "./startup-login-cookies";
const env = { NODE_ENV: "test", S3RCH_STARTUP_LOGIN_PROVIDER: "panopticon",
  S3RCH_STARTUP_AUTH_URL: "https://auth.example.invalid/auth/startup/identity",
  S3RCH_OAUTH_ISSUER: "https://startup.example.invalid/realms/isolated", S3RCH_OAUTH_CLIENT_ID: "s3rch-web" };
const base = "http://127.0.0.1:3000";
const now = 1800000000000;
function cookie(response: Response, name: string) {
  const row = response.headers.getSetCookie().filter(row => row.startsWith(name + "=")).at(-1);
  assert.ok(row); return row.split(";")[0];
}
async function setup() {
  const config = parseStartupLoginConfig(await readFile(new URL("./vectors/startup-deployment.json", import.meta.url)), env);
  const keys = await generateKeyPair("ES256");
  const start = await beginStartupOAuth(new Request(base + "/api/identity/startup/start"), env, { config: async () => config, now });
  const authorize = new URL(start.headers.get("location")!);
  const pending = cookie(start, startupPendingName(false));
  const identity = { ...config.binding, schema_version: 1, status: "resolved", permissions: [],
    person_id: "00000000-0000-4000-8000-000000000999", broker_subject: "broker-person" };
  const token = async (overrides: Record<string, unknown> = {}) => new SignJWT({ nonce: authorize.searchParams.get("nonce"), ...overrides })
    .setProtectedHeader({ alg: "ES256" }).setIssuer(config.provider.issuer).setAudience(config.provider.clientId)
    .setSubject("broker-person").setIssuedAt(now / 1000).setExpirationTime(now / 1000 + 300).sign(keys.privateKey);
  const request = (state = authorize.searchParams.get("state")) => new Request(`${base}/api/identity/oauth/callback?code=one-time&state=${state}`, { headers: { cookie: pending } });
  return { config, keys, start, authorize, pending, identity, token, request };
}

test("startup PKCE/nonce exchange returns only a bounded linked-credential cookie", async () => {
  const h = await setup(); let calls = 0;
  assert.equal(h.authorize.searchParams.get("kc_idp_hint"), "startup-entra");
  assert.equal(h.authorize.searchParams.get("code_challenge_method"), "S256");
  assert.ok(h.authorize.searchParams.get("nonce")); assert.ok(hasStartupPending(h.request()));
  const idToken = await h.token();
  const result = await finishStartupOAuth(h.request(), env, { config: async () => h.config, now, key: h.keys.publicKey,
    fetch: async (url, init) => {
      calls++;
      if (String(url) === h.config.provider.tokenEndpoint) {
        assert.equal(init?.redirect, "error");
        assert.equal((init?.body as URLSearchParams).get("grant_type"), "authorization_code");
        assert.ok((init?.body as URLSearchParams).get("code_verifier"));
        return Response.json({ id_token: idToken, access_token: "short-lived-access" });
      }
      assert.equal(url, h.config.endpoint);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer short-lived-access");
      return Response.json(h.identity);
    } });
  assert.equal(result.headers.get("location"), "/feed?startup=linked"); assert.equal(calls, 2);
  const credential = cookie(result, startupCredentialName(false));
  assert.ok(!credential.includes("short-lived-access"));
  const view = await readStartupCredential(new Request(base + "/api/identity/startup/session", { headers: { cookie: credential } }), env,
    { config: async () => h.config, now });
  assert.equal(view?.identity.sea_public_key, h.config.binding.sea_public_key);
  assert.equal(view?.identity.person_id, h.identity.person_id);
  assert.ok(view);
  const key = { pub: h.config.binding.sea_public_key, priv: "unit-only", epub: "unit-only", epriv: "unit-only" };
  const browser = createStartupLinkedLogin({ expected: view.binding, currentKey: () => key, keyRevision: () => 0,
    lookup: async () => view });
  assert.equal((await browser.login())?.sea_public_key, key.pub);
  browser.logout(); assert.equal(browser.current(), null);

  assert.equal(await readStartupCredential(new Request(base + "/api/identity/startup/session", { headers: { cookie: credential } }), env,
    { config: async () => h.config, now: now + 300000 }), null);
});

test("state mismatch or changed configuration refuses before token exchange", async () => {
  const h = await setup();
  for (const [request, config] of [[h.request("wrong"), h.config], [h.request(), { ...h.config,
    binding: { ...h.config.binding, mapping_sha256: "c".repeat(64) } }]] as const) {
    const result = await finishStartupOAuth(request, env, { config: async () => config, now,
      fetch: async () => { assert.fail("must not exchange"); } });
    assert.equal(result.headers.get("location"), "/feed?startup=denied");
  }
});

test("wrong nonce, wrong authenticated account, oversized token reply and expired PKCE deny", async () => {
  const h = await setup();
  for (const mode of ["nonce", "account", "oversized", "expired", "configuration-change"]) {
    const idToken = await h.token(mode === "nonce" ? { nonce: "wrong" } : {}); let reads = 0;
    const result = await finishStartupOAuth(h.request(), env, { config: async () => ++reads > 1 && mode === "configuration-change" ? null : h.config,
      now: mode === "expired" ? now + 300000 : now, key: h.keys.publicKey,
      fetch: async url => String(url) === h.config.provider.tokenEndpoint ?
        mode === "oversized" ? new Response("x".repeat(65537)) : Response.json({ id_token: idToken, access_token: "access" }) :
        Response.json(mode === "account" ? { ...h.identity, entra: { ...h.identity.entra, object_id: h.identity.entra.tenant_id } } : h.identity) });
    assert.equal(result.headers.get("location"), "/feed?startup=denied", mode);
  }
});

test("disabled, invalid origin and absent credential cannot start or resolve login", async () => {
  const h = await setup();
  const disabled = await beginStartupOAuth(new Request(base + "/api/identity/startup/start"), env, { config: async () => null });
  assert.equal(disabled.headers.get("location"), "/feed?startup=unavailable");
  const foreign = await beginStartupOAuth(new Request("https://foreign.invalid/api/identity/startup/start"), env, { config: async () => h.config });
  assert.equal(foreign.headers.get("location"), "/feed?startup=unavailable");
  assert.equal(await readStartupCredential(new Request(base), env, { config: async () => h.config }), null);
  assert.equal(hasStartupPending(new Request(base)), false);
});
