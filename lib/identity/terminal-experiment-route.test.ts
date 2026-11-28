// Native signing, HTTP, outbox and telemetry contracts: CI only; all owners are transport substitutions.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createTerminalExperimentRoute } from "./terminal-experiment-route";
const origin = "https://test.s3r.ch", tenant = "22222222-2222-2222-2222-222222222222";
test("native experiment completion awaits accepted telemetry and refuses uncertain withdrawal", async () => {
  const signing = generateKeyPairSync("ed25519"), now = Math.floor(Date.now() / 1000);
  const scope = { suite: "flags-s3rch-browser", subject: "11111111-1111-1111-1111-111111111111", tenant: "33333333-3333-3333-3333-333333333333", organization: "", realm: "controlplane", issuer: "https://auth.test.hyperme.sh/realms/controlplane", clients: ["s3rch-web"], origins: [origin], identities: { sea: [] } };
  const env = { S3RCH_EXPERIMENT_ORIGIN: origin, S3RCH_EXPERIMENT_TENANT: tenant, S3RCH_EXPERIMENT_SECRET: "a".repeat(64), S3RCH_EXPERIMENT_STORAGE_ORIGIN: "https://api.test.hyperme.sh",
    S3RCH_EXPERIMENT_CACHE_KEY: "cache-key-1234567890", S3RCH_EXPERIMENT_OUTBOX_KEY: "outbox-key-1234567890", S3RCH_EXPERIMENT_PUBLIC_KEY: signing.publicKey.export({ type: "spki", format: "pem" }).toString(),
    S3RCH_SESSION_SIGNING_KEY: "s".repeat(40), APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=11111111-1111-4111-8111-111111111111", S3RCH_EXPERIMENT_PRIMARY_V2: "1" };
  const payload = JSON.stringify({ version: 1, audience: "s3r.ch", sequence: 1, issuedAt: now, expiresAt: now + 300,
    experiments: [{ key: "landing-message", control: "control", variants: ["control", "create"], weights: [0, 1], disabled: false }] });
  const records = new Map<string, { value: string; revision: string }>(); let revision = 0, completed = 0, sends = 0, run = "1-1-flags-s3rch-browser", uncertain = false, lostComplete = false;
  const app = await createTerminalExperimentRoute({ serviceKey: "b".repeat(64), scope, env, enabled: true }, async (url, init) => {
    const target = String(url), headers = new Headers(init?.headers);
    if (target.endsWith("/auth/nightly-run/v1/command")) {
      const command = JSON.parse(String(init?.body)), base = { version: 1, owner: "s3rch", run, generation: "c".repeat(64) }, operation = "12345678-1234-1234-1234-123456789abc";
      if (command.action === "admit") return Response.json({ ...base, scope, operation });
      if (command.action === "complete") { if (lostComplete) throw Error("lost completion"); completed++; return Response.json({ ...base, operation, completed: true }); }
      return Response.json({ ...base, active: true });
    }
    if (target.endsWith("experiments/s3rch-cache")) return Response.json({ payload, signature: sign(null, Buffer.from(payload), signing.privateKey).toString("base64url") });
    if (target.startsWith("https://api.test.hyperme.sh/api/v1/storage/records/experiments/")) {
      assert.equal(headers.get("X-Tenant-ID"), tenant); const found = records.get(target);
      if (init?.method === "GET") return new Response(found?.value ?? null, { status: found ? 200 : 404, headers: found ? { etag: `"${found.revision}"` } : {} });
      if (found ? headers.get("if-match") !== `"${found.revision}"` : headers.get("if-none-match") !== "*") return new Response(null, { status: 412 });
      records.set(target, { value: String(init?.body), revision: (++revision).toString(16).padStart(64, "0") }); return new Response(null, { status: found ? 204 : 201 });
    }
    assert.equal(target, "https://dc.applicationinsights.azure.com/v2/track"); sends++;
    return uncertain ? new Response(null, { status: 200 }) : Response.json({ itemsReceived: 1, itemsAccepted: 1, errors: [] });
  });
  const jar = new Map<string, string>([["__Host-nightly-run-grant", "d".repeat(64)]]);
  async function post(value: unknown) {
    const response = await app.request(new Request(origin + "/api/experiments", { method: "POST", headers: { origin, "content-type": "application/json", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }, body: JSON.stringify(value) }));
    for (const cookie of response.headers.getSetCookie()) { const [k, v] = cookie.split(";")[0].split("="); if (v) jar.set(k, v); else jar.delete(k); }
    return response;
  }
  try {
    await assert.rejects(createTerminalExperimentRoute({ serviceKey: "bad", scope, env, enabled: true }));
    for (const req of [new Request(origin + "/other"), new Request("https://s3r.ch/api/experiments"),
      new Request(origin + "/api/experiments", { method: "POST", headers: { origin: "https://foreign.invalid" } })])
      assert.equal((await app.request(req)).status, 503);
    const status = await app.request(new Request(origin + "/api/experiments", { headers: { cookie: "__Host-nightly-run-grant=" + "d".repeat(64) } }));
    assert.equal(status.status, 200);
    assert.equal((await post({ action: "consent", allowed: true })).status, 200);
    const shown = await (await post({ action: "evaluate" })).json(); assert.equal(shown.variant, "create");
    const first = { action: "exposure", display: shown.display, eventId: "12345678-1234-4234-8234-123456789abc" };
    assert.equal((await post(first)).status, 200); assert.equal(sends, 1);
    assert.ok([...records.values()].some(r => JSON.parse(r.value).rows.some((row: { delivered: string[] }) => row.delivered.includes("primary"))));
    uncertain = true; const before = completed;
    assert.equal((await post({ ...first, eventId: "22345678-1234-4234-8234-123456789abc" })).status, 503);
    assert.equal(completed, before); assert.equal(sends, 2);
    const saved = JSON.stringify([...records]); run = "2-1-flags-s3rch-browser";
    const withdrawal = await post({ action: "consent", allowed: false });
    assert.equal(withdrawal.status, 200); assert.equal((await withdrawal.json()).withdrawalVerified, false);
    assert.equal(completed, before); assert.equal(JSON.stringify([...records]), saved);
    lostComplete = true;
    const lost = await post({ action: "consent", allowed: true });
    assert.equal(lost.status, 503); assert.equal(lost.headers.getSetCookie().length, 0);
  } finally { await app.close(); }
  assert.equal((await app.request(new Request(origin + "/api/experiments"))).status, 503);
});
