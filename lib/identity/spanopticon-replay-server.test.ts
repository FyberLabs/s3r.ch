import test from "node:test";
import assert from "node:assert/strict";
import { configuredIdentityReplay, createSpanopticonIdentityReplay } from "./spanopticon-replay-server";
const config = { origin: "https://storage.example", tenant: "afee9b29-1706-5590-bbbf-e58df8945ac0", apiKey: "private-replay-key", namespace: "a".repeat(64) };
const id = "b".repeat(64);

test("consume sends only a bounded nonce/expiry request with a dedicated server credential", async () => {
  const client = createSpanopticonIdentityReplay(config, async (url, init) => {
    assert.equal(url, config.origin + "/api/v1/storage/replays/" + config.namespace + "/" + id);
    assert.equal(init?.method, "POST"); assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store"); assert.equal(init?.credentials, "omit");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(init?.headers, { "X-Api-Key": config.apiKey, "X-Tenant-ID": config.tenant, "X-Replay-Expires-At": "160", "Content-Length": "0" });
    return new Response(null, { status: 204 });
  }, () => 100);
  assert.equal(await client.consume(id, 160), true);
  assert.match(client.challengeDomain, /^[a-f0-9]{64}$/);
  assert.equal(client.challengeDomain, createSpanopticonIdentityReplay({ ...config, apiKey: "rotated-key" }).challengeDomain);
  for (const override of [{ origin: "https://other.example" }, { tenant: "11111111-1111-4111-8111-111111111111" }, { namespace: "c".repeat(64) }])
    assert.notEqual(client.challengeDomain, createSpanopticonIdentityReplay({ ...config, ...override }).challengeDomain);
});

test("replay, storage failures, redirects and expiry during a response never authorize", async () => {
  for (const status of [200, 201, 301, 400, 401, 403, 409, 500, 503, 504]) {
    let canceled = false;
    const client = createSpanopticonIdentityReplay(config, async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { status }), () => 100);
    assert.equal(await client.consume(id, 160), false); assert.equal(canceled, true);
  }
  assert.equal(await createSpanopticonIdentityReplay(config, async () => { throw Error("credential must not escape"); }, () => 100).consume(id, 160), false);
  let now = 100;
  assert.equal(await createSpanopticonIdentityReplay(config, async () => { now = 160; return new Response(null, { status: 204 }); }, () => now).consume(id, 160), false);
});

test("invalid IDs, expiry or clocks never call the network", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response(null, { status: 204 }); };
  for (const [nonce, expiry] of [["../x", 160], [id, 100], [id, 161], [id, 150.5]] as const)
    assert.equal(await createSpanopticonIdentityReplay(config, fetcher, () => 100).consume(nonce, expiry), false);
  for (const clock of [NaN, Infinity, -1, 100.5])
    assert.equal(await createSpanopticonIdentityReplay(config, fetcher, () => clock).consume(id, 160), false);
  assert.equal(calls, 0);
});

test("explicit deployment configuration is complete and cannot silently fall back", () => {
  assert.equal(configuredIdentityReplay(config.namespace, {}), undefined);
  const env = { S3RCH_IDENTITY_REPLAY_BACKEND: "spanopticon", S3RCH_IDENTITY_REPLAY_ORIGIN: config.origin,
    S3RCH_IDENTITY_REPLAY_TENANT_ID: config.tenant, S3RCH_IDENTITY_REPLAY_API_KEY: config.apiKey };
  assert.ok(configuredIdentityReplay(config.namespace, env));
  for (const field of Object.keys(env)) {
    const partial = { ...env }; delete partial[field as keyof typeof partial];
    assert.throws(() => configuredIdentityReplay(config.namespace, partial));
  }
  assert.throws(() => configuredIdentityReplay(config.namespace, { ...env, S3RCH_IDENTITY_REPLAY_BACKEND: "blob" }));
  for (const override of [{ origin: "http://storage.example" }, { origin: "https://u:p@storage.example" }, { origin: "https://storage.example/path" },
    { origin: "https://storage.example:8443" }, { origin: "https://storage.example?x=1" }, { origin: "https://storage.example#x" },
    { tenant: "00000000-0000-0000-0000-000000000000" }, { tenant: "bad" }, { apiKey: "bad\nkey" }, { namespace: "../x" }])
    assert.throws(() => createSpanopticonIdentityReplay({ ...config, ...override }));
});
