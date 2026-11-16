// Native HTTP/HMAC/signing/issuer/outbox contracts: CI only. Registry/provider
// transports and page rendering are named substitutes; session GET is the app route.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { generateKeyPairSync, sign } from "node:crypto";
import { GET as nativeSession } from "../../app/api/identity/session/route";
import { createTerminalServingRouter } from "./terminal-serving-router";
import { createSeaSessionClient } from "./sea-session-client";
import { createIdentitySessions } from "./sea-session";
import { siteSeaSession } from "./site-sea-session-server";
import { signForumRecord } from "../forum-sign";
import { signSessionToken } from "./session";
import { seaSessionCookieNames } from "./sea-session-http";
import { sessionCookieName } from "./cookies";
import type { SeaPair } from "./sea";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
const origin = "https://test.s3r.ch", issuer = "https://auth.test.hyperme.sh/realms/controlplane", tenant = "22222222-2222-2222-2222-222222222222";
async function fixture() {
  const pair = await sea.pair(), signing = generateKeyPairSync("ed25519"), oldSecret = process.env.IDENTITY_SESSION_SECRET;
  const common = { subject: "11111111-1111-1111-1111-111111111111", tenant, organization: "", realm: "controlplane", issuer, clients: ["s3rch-web"], origins: [origin], identities: { sea: [pair.pub] } };
  const scopes = { "flags-s3rch-browser": { ...common, suite: "flags-s3rch-browser" }, "s3rch-device-transfer": { ...common, suite: "s3rch-device-transfer", tenant: "33333333-3333-3333-3333-333333333333", subject: "44444444-4444-4444-4444-444444444444" } };
  const config = { version: 1, owner: "s3rch", origin, authOrigin: "https://api.test.hyperme.sh", controllerKey: "a".repeat(64), ownerKey: "b".repeat(64), scopes };
  const env = { IDENTITY_SESSION_SECRET: "s".repeat(40), S3RCH_OAUTH_ISSUER: issuer, S3RCH_OAUTH_CLIENT_ID: "s3rch-web",
    S3RCH_DEVICE_TRANSFER_CONFIG: JSON.stringify({ v: 1, scope: { sourceOrigin: origin, destinationOrigin: origin, application: "s3r.ch", tenant: scopes["s3rch-device-transfer"].tenant, audience: "device" }, auth: "https://api.test.hyperme.sh/auth/sea-device-link/v1/", acl: "https://api.test.hyperme.sh/api/v1/acl/sociacl/device-transfer/", provider: "panopticon" }),
    S3RCH_IDENTITY_REPLAY_BACKEND: "spanopticon", S3RCH_IDENTITY_REPLAY_ORIGIN: "https://api.test.hyperme.sh", S3RCH_IDENTITY_REPLAY_TENANT_ID: "55555555-5555-5555-5555-555555555555", S3RCH_IDENTITY_REPLAY_API_KEY: "dedicated-replay",
    S3RCH_EXPERIMENT_ORIGIN: origin, S3RCH_EXPERIMENT_TENANT: "66666666-6666-6666-6666-666666666666", S3RCH_EXPERIMENT_SECRET: "d".repeat(64), S3RCH_EXPERIMENT_STORAGE_ORIGIN: "https://api.test.hyperme.sh",
    S3RCH_EXPERIMENT_CACHE_KEY: "cache-key-1234567890", S3RCH_EXPERIMENT_OUTBOX_KEY: "outbox-key-1234567890", S3RCH_EXPERIMENT_PUBLIC_KEY: signing.publicKey.export({ type: "spki", format: "pem" }).toString(),
    APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=11111111-1111-4111-8111-111111111111" };
  process.env.IDENTITY_SESSION_SECRET = env.IDENTITY_SESSION_SECRET;
  const state = { suite: "flags-s3rch-browser" as keyof typeof scopes, admitted: 0, complete: 0, network: 0, legacy: 0, active: true };
  const records = new Map<string, { value: string; revision: string }>(); let revision = 0;
  const now = Math.floor(Date.now() / 1000), payload = JSON.stringify({ version: 1, audience: "s3r.ch", sequence: 1, issuedAt: now, expiresAt: now + 300,
    experiments: [{ key: "landing-message", control: "control", variants: ["control", "create"], weights: [0, 1], disabled: false }] });
  const transport: typeof fetch = async (url, init) => {
    state.network++; const target = String(url), headers = new Headers(init?.headers);
    if (target.endsWith("/auth/nightly-run/v1/command")) {
      const command = JSON.parse(String(init?.body)), base = { version: 1, owner: "s3rch", run: "1-1-" + state.suite, generation: "e".repeat(64) };
      if (command.action === "admit") { state.admitted++; return Response.json({ ...base, scope: scopes[state.suite], operation: "12345678-1234-1234-1234-123456789abc" }); }
      if (command.action === "complete") { state.complete++; return Response.json({ ...base, operation: command.operation, completed: true }); }
      return Response.json({ ...base, active: state.active });
    }
    if (target.includes("/storage/replays/")) { assert.equal(headers.get("X-Tenant-ID"), env.S3RCH_IDENTITY_REPLAY_TENANT_ID); return new Response(null, { status: 204 }); }
    if (target.endsWith("experiments/s3rch-cache")) return Response.json({ payload, signature: sign(null, Buffer.from(payload), signing.privateKey).toString("base64url") });
    if (target.includes("/storage/records/experiments/")) {
      assert.equal(headers.get("X-Tenant-ID"), env.S3RCH_EXPERIMENT_TENANT);
      const row = records.get(target);
      if (init?.method === "GET") return new Response(row?.value ?? null, { status: row ? 200 : 404, headers: row ? { etag: `"${row.revision}"` } : {} });
      assert.equal(row ? headers.get("if-match") : headers.get("if-none-match"), row ? `"${row.revision}"` : "*");
      records.set(target, { value: String(init?.body), revision: (++revision).toString(16).padStart(64, "0") }); return new Response(null, { status: row ? 204 : 201 });
    }
    throw Error("Unexpected owner target");
  };
  const router = await createTerminalServingRouter({ config: JSON.stringify(config), env, experimentsEnabled: true }, async request => {
    state.legacy++; const path = new URL(request.url).pathname;
    if (path === "/api/identity/session") return nativeSession(request);
    if (path.startsWith("/api/identity/sea/")) return siteSeaSession(request, path.split("/").at(-1)!, env, transport);
    return Response.json({ rendered: true }); // Page renderer only; no identity behavior substituted.
  }, transport);
  const jar = new Map<string, string>([["__Host-nightly-run-grant", "c".repeat(64)]]);
  async function request(path: string, body?: unknown) {
    const response = await router.request(new Request(origin + path, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json", cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ") }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    for (const cookie of response.headers.getSetCookie()) { const [key, ...values] = cookie.split(";")[0].split("="); const value = values.join("="); if (value) jar.set(key, value); else jar.delete(key); }
    return response;
  }
  return { router, pair, env, state, jar, records, request, async close() { await router.close(); if (oldSecret === undefined) delete process.env.IDENTITY_SESSION_SECRET; else process.env.IDENTITY_SESSION_SECRET = oldSecret; } };
}
test("both SEA suites use one admission and the actual auxiliary session route", async () => {
  const h = await fixture();
  try {
    for (const suite of ["flags-s3rch-browser", "s3rch-device-transfer"] as const) {
      h.state.suite = suite; const before = h.state.admitted;
      const client = createSeaSessionClient({ origin, base: "/api/identity/sea", fetch: async (url, init) => h.request(new URL(String(url), origin).pathname, init?.body ? JSON.parse(String(init.body)) : undefined) });
      assert.equal(await client.signIn(h.pair), true); assert.equal(h.state.admitted - before, 2); // challenge, exchange; no trial admission.
      const response = await h.request("/api/identity/session"); assert.equal(response.status, 200); assert.equal((await response.json()).owner, h.pair.pub);
      await client.logout();
    }
    h.state.suite = "s3rch-device-transfer"; assert.equal((await h.request("/api/identity/device/authorize")).status, 302);
  } finally { await h.close(); }
});
test("absent-grant anonymous consent and withdrawal cannot touch native fixture outbox", async () => {
  const h = await fixture();
  try {
    assert.equal((await h.request("/api/experiments", { action: "consent", allowed: true })).status, 200);
    assert.equal((await h.request("/api/experiments", { action: "evaluate" })).status, 200); assert.ok(h.records.size);
    const beforeForeignTenant = JSON.stringify([...h.records]);
    assert.equal((await h.request("/api/experiments", { action: "consent", allowed: true, tenant: "77777777-7777-7777-7777-777777777777" })).status, 400);
    assert.equal(JSON.stringify([...h.records]), beforeForeignTenant);
    h.jar.delete("__Host-nightly-run-grant"); const saved = JSON.stringify([...h.records]), before = h.state.network;
    for (const body of [{ action: "consent", allowed: false }, { action: "consent", allowed: true }, { action: "evaluate" }])
      assert.equal((await h.request("/api/experiments", body)).status, 503);
    assert.equal(h.state.network, before); assert.equal(JSON.stringify([...h.records]), saved);
  } finally { await h.close(); }
});
test("old fixture and wallet credentials cannot become SEA owners; unrelated SEA remains usable", async () => {
  const h = await fixture(), unrelated = await sea.pair();
  try {
    h.jar.clear(); const sessions = createIdentitySessions({ origin, secret: h.env.IDENTITY_SESSION_SECRET, consume: async () => true });
    async function legacy(pair: SeaPair) { const challenge = await sessions.challenge(pair.pub); return sessions.exchange(challenge, (await signForumRecord(challenge, pair))!); }
    const old = await legacy(h.pair); assert.ok(old); h.jar.set(seaSessionCookieNames()[0], old);
    assert.equal((await h.request("/api/identity/session")).status, 401);
    const other = await legacy(unrelated); assert.ok(other); h.jar.set(seaSessionCookieNames()[0], other);
    assert.equal((await (await h.request("/api/identity/session")).json()).owner, unrelated.pub);
    h.jar.clear(); h.jar.set(sessionCookieName(true), await signSessionToken({ address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", chainId: 1 }, h.env.IDENTITY_SESSION_SECRET));
    assert.equal((await (await h.request("/api/identity/session")).json()).owner, "");
    for (const path of ["/api/identity/verify", "/api/identity/oauth/link", "/api/identity/sea/linked-exchange", "/api/identity/agent/exchange"])
      assert.equal((await h.request(path, {})).status, 503);
  } finally { await h.close(); }
});
test("navigation stays policy-enclosed, unknown API paths refuse and close is not terminal proof", async () => {
  const h = await fixture();
  try {
    for (const path of ["/", "/feed", "/identity/devices", "/feed-cache/snapshot.json"]) assert.equal((await h.request(path)).status, 200);
    assert.equal((await h.request("/api/unknown", {})).status, 503);
    assert.equal((await h.request("/api/identity/startup/availability")).status, 503); // No private mapping fixture installed.
    assert.equal((await h.request("/api/internal/nightly-run", {})).status, 409);
    assert.equal((await h.router.request(new Request("https://s3r.ch/"))).status, 503);
    const before = h.state.complete; await h.router.close(); assert.equal((await h.request("/")).status, 503); assert.equal(h.state.complete, before);
  } finally { await h.close(); }
});
