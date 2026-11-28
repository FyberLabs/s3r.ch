// Native PKCE/JWT, private configuration and HTTP contracts: CI only.
// Registry, provider token endpoint and Auth identity transports are substitutes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { generateKeyPair, SignJWT } from "jose";
import { parseStartupLoginConfig } from "./startup-login-config";
import { createTerminalStartupRoute } from "./terminal-startup-route";
import { startupPendingName, startupCredentialName } from "./startup-login-cookies";
const origin = "https://test.s3r.ch", issuer = "https://auth.test.hyperme.sh/realms/controlplane";
const subject = "11111111-1111-1111-1111-111111111111", generation = "a".repeat(64), grant = "b".repeat(64);
const pub = "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.sBy9HAHlgGVxGBS1g_Bh6dQxzKmUzqExNEm_l8hArgo";
const env = { NODE_ENV: "production", S3RCH_SESSION_SIGNING_KEY: "s".repeat(40), S3RCH_STARTUP_LOGIN_PROVIDER: "panopticon",
  S3RCH_STARTUP_AUTH_URL: "https://api.test.hyperme.sh/auth/startup/identity", S3RCH_OAUTH_ISSUER: issuer, S3RCH_OAUTH_CLIENT_ID: "s3rch-web" };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value);
}
async function fixture() {
  const doc = JSON.parse(await readFile(new URL("./vectors/startup-deployment.json", import.meta.url), "utf8"));
  doc.binding.sea_public_key = pub; doc.owner.broker.issuer = issuer;
  doc.binding_sha256 = createHash("sha256").update(canonical(doc.binding) + "\n").digest("hex");
  const config = parseStartupLoginConfig(Buffer.from(canonical(doc) + "\n"), env), keys = await generateKeyPair("ES256");
  const scope = { suite: "flags-s3rch-browser", subject, tenant: config.binding.tenant_id, organization: "", realm: "controlplane", issuer,
    clients: ["s3rch-web"], origins: [origin], identities: { sea: [pub] } };
  const state = { run: "1-1-flags-s3rch-browser", active: true, complete: 0, exchanged: 0, lookedUp: 0,
    nonce: "", loseIdentity: false, loseComplete: false, foreignConfig: false };
  const cookies = new Map<string, string>([["__Host-nightly-run-grant", grant]]);
  const transport: typeof fetch = async (url, init) => {
    if (url === config.provider.tokenEndpoint) {
      state.exchanged++;
      const token = await new SignJWT({ nonce: state.nonce, nightly_run: { run: state.run, generation } }).setProtectedHeader({ alg: "ES256" })
        .setIssuer(issuer).setAudience("s3rch-web").setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
      return Response.json({ id_token: token, access_token: "provider-access" });
    }
    if (url === config.endpoint) {
      state.lookedUp++; const headers = new Headers(init?.headers);
      assert.equal(init?.method, "GET"); assert.equal(headers.get("authorization"), "Bearer provider-access");
      assert.equal(headers.get("X-Nightly-Run-Grant"), grant); assert.equal(headers.has("cookie"), false);
      if (state.loseIdentity) throw Error("lost identity response");
      return Response.json({ ...config.binding, schema_version: 1, status: "resolved", permissions: [],
        person_id: "00000000-0000-4000-8000-000000000999", broker_subject: subject });
    }
    assert.equal(url, "https://api.test.hyperme.sh/auth/nightly-run/v1/command");
    const command = JSON.parse(String(init?.body)), base = { version: 1, owner: "s3rch", run: state.run, generation };
    if (command.action === "admit") return Response.json({ ...base, scope, operation: "12345678-1234-1234-1234-123456789abc" });
    if (command.action === "complete") { if (state.loseComplete) throw Error("lost completion"); state.complete++; return Response.json({ ...base, operation: command.operation, completed: true }); }
    return Response.json({ ...base, active: state.active });
  };
  const route = createTerminalStartupRoute({ serviceKey: "c".repeat(64), scope, env }, { fetch: transport, key: keys.publicKey,
    config: async () => state.foreignConfig ? { ...config, binding: { ...config.binding, tenant_id: subject } } : config });
  const request = (path: string) => new Request(origin + path, { headers: { cookie: [...cookies].map(([k, v]) => k + "=" + v).join("; ") } });
  function save(response: Response) { for (const line of response.headers.getSetCookie()) { const [key, ...value] = line.split(";")[0].split("="); if (value.join("=")) cookies.set(key, value.join("=")); else cookies.delete(key); } }
  async function start() {
    const response = await route(request("/api/identity/startup/start")); assert.equal(response.status, 302); save(response);
    const authorize = new URL(response.headers.get("location")!); state.nonce = authorize.searchParams.get("nonce")!;
    assert.ok(cookies.get(startupPendingName(true)));
    return "/api/identity/oauth/callback?code=once&state=" + authorize.searchParams.get("state");
  }
  return { scope, config, state, cookies, route, request, save, start };
}
test("native startup exchange forwards the original grant and verifies its bound credential", async () => {
  const h = await fixture();
  assert.equal((await h.route(h.request("/api/identity/startup/availability"))).status, 200);
  const callback = await h.start(), response = await h.route(h.request(callback));
  assert.equal(response.headers.get("location"), "/feed?startup=linked"); h.save(response); assert.ok(h.cookies.get(startupCredentialName(true)));
  const session = await h.route(h.request("/api/identity/startup/session")); assert.equal(session.status, 200);
  assert.equal((await session.json()).verifiedSubject, subject); assert.equal(h.state.exchanged, 1); assert.equal(h.state.lookedUp, 1);
  const completed = h.state.complete; h.state.run = "2-1-flags-s3rch-browser";
  assert.equal((await h.route(h.request("/api/identity/startup/session"))).status, 401); assert.equal(h.state.complete, completed);
  h.state.active = false; assert.equal((await h.route(h.request("/api/identity/startup/start"))).status, 503);
});
test("failed callbacks and lost owner outcomes retain pending work and withhold issued credentials", async () => {
  for (const mode of ["state", "identity", "completion"]) {
    const h = await fixture(), callback = await h.start(), before = h.state.complete;
    h.state.loseIdentity = mode === "identity"; h.state.loseComplete = mode === "completion";
    const response = await h.route(h.request(mode === "state" ? callback + "-wrong" : callback));
    assert.equal(h.state.complete, before);
    if (mode === "completion") { assert.equal(response.status, 503); assert.equal(response.headers.has("set-cookie"), false); }
    else assert.equal(response.headers.get("location"), "/feed?startup=denied");
  }
});
test("missing grant, alternate paths and changed native scope refuse without startup effects", async () => {
  const h = await fixture();
  for (const req of [new Request(origin + "/api/identity/startup/start"), h.request("/api/identity/oauth/start"),
    new Request("https://s3r.ch/api/identity/startup/start"), new Request(origin + "/api/identity/startup/start", { method: "POST" })])
    assert.equal((await h.route(req)).status, 503);
  h.state.foreignConfig = true; assert.equal((await h.route(h.request("/api/identity/startup/start"))).status, 503);
  assert.equal(h.state.exchanged, 0); assert.equal(h.state.lookedUp, 0); assert.equal(h.state.complete, 0);
  assert.throws(() => createTerminalStartupRoute({ serviceKey: "bad", scope: h.scope, env }));
});
