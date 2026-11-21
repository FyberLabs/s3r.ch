import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { generateKeyPair, SignJWT } from "jose";
import { beginStartupOAuth, finishStartupOAuth, readStartupCredential, hasStartupPending } from "./startup-oauth";
import { createStartupLinkedLogin } from "./startup-linked-login";
import { parseStartupLoginConfig, TEST_GITHUB_MEMBER_ENDPOINT, TEST_NIGHTLY_MEMBER_ENDPOINT } from "./startup-login-config";
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
  assert.equal(h.authorize.searchParams.has("prompt"), false);
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

test("the TEST GitHub linked sign-in requests a fresh broker challenge", async () => {
  const issuer = "https://auth.test.hyperme.sh/realms/controlplane";
  const subject = "00000000-0000-4000-8000-000000000121";
  const tenant_id = "00000000-0000-4000-8000-000000000123";
  const vector = JSON.parse(await readFile(new URL("./vectors/startup-deployment.json", import.meta.url), "utf8"));
  const mapping = { broker: { audience: "s3rch-web", issuer, provider: "github", subject },
    environment: "test", network_id: "hyperme.sh", sea_public_key: vector.binding.sea_public_key, tenant_id, version: 1 };
  const config = parseStartupLoginConfig(new TextEncoder().encode(JSON.stringify(mapping) + "\n"),
    { ...env, S3RCH_OAUTH_ISSUER: issuer, S3RCH_STARTUP_AUTH_URL: TEST_GITHUB_MEMBER_ENDPOINT });
  const start = await beginStartupOAuth(new Request("https://test.s3r.ch/api/identity/startup/start"), env,
    { config: async () => config, now });
  const authorize = new URL(start.headers.get("location")!);
  assert.equal(authorize.searchParams.get("kc_idp_hint"), "github");
  assert.equal(authorize.searchParams.get("prompt"), "login");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
});

test("the dedicated TEST client carries its verified broker selection through callback and session", async () => {
  const issuer = "https://auth.test.hyperme.sh/realms/controlplane", audience = "s3rch-startup-nightly";
  const subject = "00000000-0000-4000-8000-000000000121";
  const tenant_id = "00000000-0000-4000-8000-000000000123";
  const vector = JSON.parse(await readFile(new URL("./vectors/startup-deployment.json", import.meta.url), "utf8"));
  const mapping = { broker: { audience, issuer, provider: "startup-nightly", subject },
    environment: "test", network_id: "hyperme.sh", sea_public_key: vector.binding.sea_public_key, tenant_id, version: 1 };
  const serialized = JSON.stringify(mapping) + "\n";
  const configuration = { ...env, S3RCH_STARTUP_LOGIN_ENABLED: "1", S3RCH_STARTUP_NIGHTLY_MEMBER_CONFIG: serialized };
  const site = "https://test.s3r.ch", startPath = "/api/identity/startup/start?provider=startup-nightly";
  const foreign = await beginStartupOAuth(new Request("https://s3r.ch" + startPath), configuration, { now });
  assert.equal(foreign.headers.get("location"), "/feed?startup=unavailable");
  const start = await beginStartupOAuth(new Request(site + startPath), configuration, { now });
  const authorize = new URL(start.headers.get("location")!);
  assert.equal(authorize.searchParams.get("kc_idp_hint"), "startup-nightly");
  assert.equal(authorize.searchParams.get("client_id"), audience);
  assert.equal(authorize.searchParams.get("prompt"), "login");
  const keys = await generateKeyPair("ES256");
  const config = parseStartupLoginConfig(new TextEncoder().encode(serialized), configuration, true);
  const idToken = await new SignJWT({ nonce: authorize.searchParams.get("nonce") })
    .setProtectedHeader({ alg: "ES256" }).setIssuer(issuer).setAudience(audience)
    .setSubject(subject).setIssuedAt(now / 1000).setExpirationTime(now / 1000 + 60).sign(keys.privateKey);
  const identity = { ...config.binding, schema_version: 1, status: "resolved", permissions: [],
    person_id: "00000000-0000-4000-8000-000000000999", broker_subject: subject };
  const callback = new Request(site + "/api/identity/oauth/callback?code=one-time&state=" + authorize.searchParams.get("state"),
    { headers: { cookie: cookie(start, startupPendingName(true)) } });
  const result = await finishStartupOAuth(callback, configuration, { now, key: keys.publicKey, fetch: async url => {
    if (String(url) === config.provider.tokenEndpoint) return Response.json({ id_token: idToken, access_token: "synthetic-access" });
    assert.equal(String(url), TEST_NIGHTLY_MEMBER_ENDPOINT);
    return Response.json(identity);
  } });
  assert.equal(result.headers.get("location"), "/feed?startup=linked");
  const session = new Request(site + "/api/identity/startup/session", {
    headers: { cookie: cookie(result, startupCredentialName(true)) },
  });
  assert.deepEqual((await readStartupCredential(session, configuration, { now }))?.identity.oidc,
    { provider: "startup-nightly", subject });
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
        Response.json(mode === "account" ? { ...h.identity, entra: { ...h.identity.entra, object_id: h.identity.entra?.tenant_id } } : h.identity) });
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

// Provider work may cross a wall-clock second. Verify against completion time,
// while retaining the original pending-cookie deadline.
test("provider exchange crossing a second accepts fresh tokens but never extends the original attempt", async () => {
  for (const delay of [1000, 301000]) {
    const h = await setup(); let clock = now;
    const result = await finishStartupOAuth(h.request(), env, { config: async () => h.config, clock: () => clock, key: h.keys.publicKey,
      fetch: async url => {
        if (String(url) === h.config.provider.tokenEndpoint) {
          clock += delay;
          const token = await new SignJWT({ nonce: h.authorize.searchParams.get("nonce") })
            .setProtectedHeader({ alg: "ES256" }).setIssuer(h.config.provider.issuer).setAudience(h.config.provider.clientId)
            .setSubject("broker-person").setIssuedAt(clock / 1000).setExpirationTime(clock / 1000 + 300).sign(h.keys.privateKey);
          return Response.json({ id_token: token, access_token: "synthetic-access" });
        }
        return Response.json(h.identity);
      } });
    assert.equal(result.headers.get("location"), delay < 300000 ? "/feed?startup=linked" : "/feed?startup=denied");
  }
});
