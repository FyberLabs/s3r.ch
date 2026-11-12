import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createCachedExperimentProvider } from "./experiment-cache-provider";
const keys = generateKeyPairSync("ed25519");
const envelope = (sequence: number, disabled = false) => {
  const payload = JSON.stringify({ version: 1, audience: "s3r.ch", sequence, issuedAt: 100, expiresAt: 400,
    experiments: [{ key: "layout", control: "control", variants: ["control", "treatment"], weights: [0, 1], disabled }] });
  return { bytes: new TextEncoder().encode(JSON.stringify({ payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64url") })), revision: "a".repeat(64) };
};
test("signed cache payloads refresh and share guardrail disables", async () => {
  let now = 100, value = envelope(1), calls = 0;
  const p = await createCachedExperimentProvider({ publicKey: keys.publicKey, domain: "cache-signed", clock: () => now,
    records: { async get(namespace, name, signal) { calls++; assert.equal(namespace, "cache"); assert.equal(name, "experiments-v1-s3rch"); assert.equal(signal?.aborted, false); return value; } } });
  try {
    assert.deepEqual(p.definitions(), []);
    assert.equal(await p.refresh(), true);
    assert.equal(await p.choose("layout", "a".repeat(64)), "treatment");
    assert.equal(await p.refresh(), false); assert.equal(calls, 1);
    value = envelope(2, true); now = 130;
    assert.equal(await p.refresh(), true); assert.equal(p.guardrailHealthy("layout"), false);
    assert.equal(await p.choose("layout", "a".repeat(64)), "control");
    now = 400; assert.deepEqual(p.definitions(), []);
    await assert.rejects(() => p.choose("layout", "a".repeat(64)));
  } finally { await p.close(); }
});
test("absent, corrupt, forged or failed cache reads retain only unexpired flags", async () => {
  let now = 100, value: ReturnType<typeof envelope> | null = envelope(1), fail = false;
  const p = await createCachedExperimentProvider({ publicKey: keys.publicKey, domain: "cache-refusal", clock: () => now,
    records: { async get() { if (fail) throw Error("private transport details"); return value; } } });
  try {
    await p.refresh();
    for (const bytes of [new Uint8Array(65537), new Uint8Array([255]), Buffer.from("null"), Buffer.from("[]"), Buffer.from("{}"),
      Buffer.from('{"payload":1,"signature":"x"}'), Buffer.from('{"payload":"{}","signature":"x"}'),
      Buffer.from('{"payload":"{}","signature":"x","private":"no"}')]) {
      now += 30; value = { bytes, revision: "a".repeat(64) };
      assert.equal(await p.refresh(), false); assert.equal(p.definitions().length, 1);
    }
    now += 30; value = null; assert.equal(await p.refresh(), false);
    now += 30; fail = true; assert.equal(await p.refresh(), false); assert.deepEqual(p.definitions(), []);
  } finally { await p.close(); }
});
test("concurrent callers share one read and close prevents late activation", async () => {
  let finish!: (value: ReturnType<typeof envelope>) => void, calls = 0;
  let signal: AbortSignal | undefined;
  const p = await createCachedExperimentProvider({ publicKey: keys.publicKey, domain: "cache-concurrent", clock: () => 100,
    records: { get(_namespace, _name, active) { calls++; signal = active; return new Promise(resolve => { finish = resolve; }); } } });
  const first = p.refresh(), second = p.refresh();
  await Promise.resolve();
  assert.equal(calls, 1); assert.equal(first, second);
  const closing = p.close(); assert.equal(signal?.aborted, true);
  finish(envelope(1)); assert.equal(await first, false); await closing;
  assert.equal(await p.refresh(), false); assert.deepEqual(p.definitions(), []);
});
test("bad clocks refuse reads and backward clocks do not prolong throttling", async () => {
  let now = NaN, calls = 0;
  const p = await createCachedExperimentProvider({ publicKey: keys.publicKey, domain: "cache-clock", clock: () => now,
    records: { async get() { calls++; return null; } } });
  try {
    assert.equal(await p.refresh(), false); assert.equal(calls, 0);
    now = 200; await p.refresh(); now = 150; await p.refresh(); assert.equal(calls, 2);
  } finally { await p.close(); }
});
test("a hung read is aborted and cannot activate flags after the deadline", async () => {
  let finish!: (value: ReturnType<typeof envelope>) => void, signal: AbortSignal | undefined;
  const p = await createCachedExperimentProvider({ publicKey: keys.publicKey, domain: "cache-timeout", clock: () => 100,
    records: { get(_namespace, _name, active) { signal = active; return new Promise(resolve => { finish = resolve; }); } } });
  try {
    assert.equal(await p.refresh(), false); assert.equal(signal?.aborted, true);
    finish(envelope(1)); await Promise.resolve(); assert.deepEqual(p.definitions(), []);
  } finally { await p.close(); }
});

test("a synchronous transport exception does not stick the refresh promise", async () => {
  let now = 100, calls = 0;
  const p = await createCachedExperimentProvider({ publicKey: keys.publicKey, domain: "cache-sync-throw", clock: () => now,
    records: { get() { calls++; throw Error("private provider failure"); } } });
  try {
    assert.equal(await p.refresh(), false); now = 130;
    assert.equal(await p.refresh(), false); assert.equal(calls, 2);
  } finally { await p.close(); }
});
