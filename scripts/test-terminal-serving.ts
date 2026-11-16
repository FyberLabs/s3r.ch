// Built Next HTTP/native signing contracts: CI only. Remote owners are explicit substitutes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { createIdentitySessions } from "../lib/identity/sea-session";
import { createSeaSessionClient } from "../lib/identity/sea-session-client";
import { signForumRecord } from "../lib/forum-sign";
import { seaSessionCookieNames } from "../lib/identity/sea-session-http";
import type { SeaPair } from "../lib/identity/sea";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
const origin = "https://test.s3r.ch", issuer = "https://auth.test.hyperme.sh/realms/controlplane", tenant = "22222222-2222-2222-2222-222222222222";
const pair = await sea.pair(), other = await sea.pair(), unrelated = await sea.pair(), signing = generateKeyPairSync("ed25519");
  const common = { subject: "11111111-1111-1111-1111-111111111111", tenant, organization: "", realm: "controlplane", issuer, clients: ["s3rch-web"], origins: [origin], identities: { sea: [pair.pub] } };
  const scopes = { "flags-s3rch-browser": { ...common, suite: "flags-s3rch-browser" }, "s3rch-device-transfer": { ...common, suite: "s3rch-device-transfer", tenant: "33333333-3333-3333-3333-333333333333", subject: "44444444-4444-4444-4444-444444444444" } };
  const config = { version: 1, owner: "s3rch", origin, authOrigin: "https://api.test.hyperme.sh", controllerKey: "a".repeat(64), ownerKey: "b".repeat(64), scopes };
  const env: Record<string, string> = { IDENTITY_SESSION_SECRET: "s".repeat(40), S3RCH_OAUTH_ISSUER: issuer, S3RCH_OAUTH_CLIENT_ID: "s3rch-web",
    S3RCH_DEVICE_TRANSFER_CONFIG: JSON.stringify({ v: 1, scope: { sourceOrigin: origin, destinationOrigin: origin, application: "s3r.ch", tenant: scopes["s3rch-device-transfer"].tenant, audience: "device" }, auth: "https://api.test.hyperme.sh/auth/sea-device-link/v1/", acl: "https://api.test.hyperme.sh/api/v1/acl/sociacl/device-transfer/", provider: "panopticon" }),
    S3RCH_IDENTITY_REPLAY_BACKEND: "spanopticon", S3RCH_IDENTITY_REPLAY_ORIGIN: "https://api.test.hyperme.sh", S3RCH_IDENTITY_REPLAY_TENANT_ID: "55555555-5555-5555-5555-555555555555", S3RCH_IDENTITY_REPLAY_API_KEY: "dedicated-replay",
    S3RCH_EXPERIMENT_ORIGIN: origin, S3RCH_EXPERIMENT_TENANT: "66666666-6666-6666-6666-666666666666", S3RCH_EXPERIMENT_SECRET: "d".repeat(64), S3RCH_EXPERIMENT_STORAGE_ORIGIN: "https://api.test.hyperme.sh",
    S3RCH_EXPERIMENT_CACHE_KEY: "cache-key-1234567890", S3RCH_EXPERIMENT_OUTBOX_KEY: "outbox-key-1234567890", S3RCH_EXPERIMENT_PUBLIC_KEY: signing.publicKey.export({ type: "spki", format: "pem" }).toString(),
    APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=11111111-1111-4111-8111-111111111111" };

config.scopes["s3rch-device-transfer"].identities = { sea: [other.pub] };
const sessions = createIdentitySessions({ origin, secret: env.IDENTITY_SESSION_SECRET, consume: async () => true });
async function legacy(key: SeaPair) { const challenge = await sessions.challenge(key.pub); return (await sessions.exchange(challenge, (await signForumRecord(challenge, key))!))!; }
const oldFixture = await legacy(pair), oldUnrelated = await legacy(unrelated);
const port = "3939", local = "http://127.0.0.1:" + port;
async function boot(raw?: string) {
  const childEnv = { PATH: process.env.PATH, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: port, ...env,
    ...(raw === undefined ? {} : { S3RCH_NIGHTLY_RUN_CONFIG: raw }) };
  const child = spawn(process.execPath, ["--require", path.resolve("scripts/terminal-owner-fixture.cjs"), "server.js"], {
    cwd: path.resolve(".next/standalone"), env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", value => log += value); child.stderr.on("data", value => log += value);
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw Error(log);
    if (log.includes("Ready in")) { ready = true; break; }
    await delay(100);
  }
  assert.ok(ready, log);
  return async () => { if (child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; } };
}
function browser(grant?: string) {
  const jar = new Map<string, string>(grant ? [["__Host-nightly-run-grant", grant]] : []);
  async function request(route: string, body?: unknown, extra: Record<string, string> = {}) {
    const response = await fetch(local + route, { method: body === undefined ? "GET" : "POST", redirect: "manual",
      headers: { host: "test.s3r.ch", "x-forwarded-host": "test.s3r.ch", "x-forwarded-proto": "https", origin,
        "content-type": "application/json", cookie: [...jar].map(([k,v]) => k + "=" + v).join("; "), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const cookie of response.headers.getSetCookie()) { const [key, ...values] = cookie.split(";")[0].split("="); const value = values.join("="); if (value) jar.set(key, value); else jar.delete(key); }
    return response;
  }
  return { jar, request };
}
let stop = await boot();
try {
  const b = browser();
  assert.equal((await b.request("/api/internal/nightly-run", {})).status, 404);
  b.jar.set(seaSessionCookieNames()[0], oldFixture);
  assert.equal((await (await b.request("/api/identity/session")).json()).owner, pair.pub);
} finally { await stop(); }
stop = await boot("invalid");
try {
  for (const route of ["/", "/api/identity/session", "/api/experiments", "/api/internal/nightly-run"])
    assert.equal((await browser().request(route)).status, 503);
} finally { await stop(); }
stop = await boot(JSON.stringify(config));
try {
  const b = browser();
  for (const route of ["/api/identity/verify", "/api/identity/oauth/start", "/api/identity/sea/linked-exchange"])
    assert.equal((await b.request(route, {}, { "x-nightly-run-grant": "c".repeat(64), "x-terminal-admitted": "true" })).status, 503);
  assert.equal((await b.request("/api/experiments", { action: "consent", allowed: true })).status, 503);
  assert.equal((await b.request("/api/internal/nightly-run", {})).status, 409);
  b.jar.set(seaSessionCookieNames()[0], oldFixture);
  assert.equal((await b.request("/api/identity/session")).status, 401);
  b.jar.set(seaSessionCookieNames()[0], oldUnrelated);
  assert.equal((await (await b.request("/api/identity/session")).json()).owner, unrelated.pub);
  // Concurrent suites exercise separate compiled route bundles and request-local ALS.
  const clients = [[pair, "c"], [other, "f"]] as const;
  await Promise.all(clients.map(async ([key, prefix]) => {
    const b = browser(prefix.repeat(64));
    const client = createSeaSessionClient({ origin, base: "/api/identity/sea", fetch: async (url, init) => b.request(new URL(String(url), origin).pathname, init?.body ? JSON.parse(String(init.body)) : undefined) });
    assert.equal(await client.signIn(key), true);
    assert.equal((await (await b.request("/api/identity/session")).json()).owner, key.pub);
    b.jar.delete("__Host-nightly-run-grant");
    assert.equal((await b.request("/api/identity/session")).status, 401);
  }));
  assert.equal((await browser("f".repeat(64)).request("/api/identity/device/authorize")).status, 302);
  assert.equal((await browser("c".repeat(64)).request("/api/identity/startup/availability")).status, 503); // no private startup mapping
  assert.equal((await browser("c".repeat(64)).request("/api/unknown")).status, 503);
  assert.equal((await fetch(local + "/api/health")).status, 200);
} finally { await stop(); }
console.log("Built Next terminal entry contracts passed");
