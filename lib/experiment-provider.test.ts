import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createExperimentProvider } from "./experiment-provider";
import { createExperimentState } from "./experiment-state";
const keys = generateKeyPairSync("ed25519");
const config = (sequence = 1) => ({ version: 1, audience: "s3r.ch", sequence, issuedAt: 100, expiresAt: 200,
  experiments: [{ key: "layout", control: "control", variants: ["control", "treatment"], weights: [0, 1], disabled: false }] });
const signed = (value: unknown) => { const raw = JSON.stringify(value); return [raw, sign(null, Buffer.from(raw), keys.privateKey).toString("base64url")] as const; };

test("real OpenFeature GrowthBook evaluation uses only local signed payloads and keyed contexts", async () => {
  const original = globalThis.fetch; let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw Error("network forbidden in this unit contract"); };
  const p = await createExperimentProvider({ publicKey: keys.publicKey, domain: "provider-local", clock: () => 101 });
  try {
    assert.deepEqual(p.definitions(), []);
    assert.equal(p.guardrailHealthy("layout"), false);
    await assert.rejects(() => p.choose("layout", "a".repeat(64)));
    assert.equal(await p.refresh(...signed(config())), true);
    assert.equal(await p.choose("layout", "a".repeat(64)), "treatment");
    assert.equal(p.guardrailHealthy("layout"), true);
    await assert.rejects(() => p.choose("layout", "raw-private-id"));
    const state = await createExperimentState({ secret: new Uint8Array(32).fill(97) })("", null, p.definitions());
    assert.equal((await state.evaluate("layout", key => p.choose("layout", key), p.guardrailHealthy("layout"))).variant, "treatment");
    const disabled = config(2); disabled.experiments[0].disabled = true;
    assert.equal(await p.refresh(...signed(disabled)), true);
    assert.equal(p.guardrailHealthy("layout"), false);
    assert.equal((await state.evaluate("layout", key => p.choose("layout", key), p.guardrailHealthy("layout"))).variant, "control");
    assert.equal(fetches, 0);
  } finally { await p.close(); globalThis.fetch = original; }
});

test("forged, stale, foreign and malformed refreshes preserve the last usable payload", async () => {
  let now = 101;
  const p = await createExperimentProvider({ publicKey: keys.publicKey, domain: "provider-refusal", clock: () => now });
  try {
    assert.equal(await p.refresh(...signed(config())), true);
    const [raw, signature] = signed(config(2));
    for (const input of [[raw + " ", signature], [raw, "invalid"], ["x".repeat(32769), signature], signed(config()),
      signed({ ...config(2), audience: "portal" }), signed({ ...config(2), email: "private" }),
      signed({ ...config(2), issuedAt: 102 }), signed({ ...config(2), expiresAt: 99 }),
      signed({ ...config(2), expiresAt: 1000000 }), signed({ ...config(2), sequence: 1.5 }),
      signed({ ...config(2), experiments: [config(2).experiments[0], config(2).experiments[0]] }),
      signed({ ...config(2), experiments: [{ ...config(2).experiments[0], weights: [0.5, 0.6] }] }),
      signed({ ...config(2), experiments: [{ ...config(2).experiments[0], condition: { age: 18 } }] })] as Array<readonly [string, string]>) {
      assert.equal(await p.refresh(input[0], input[1]), false);
      assert.equal(await p.choose("layout", "a".repeat(64)), "treatment");
    }
    now = 201;
    assert.deepEqual(p.definitions(), []);
    assert.equal(p.guardrailHealthy("layout"), false);
    await assert.rejects(() => p.choose("layout", "a".repeat(64)));
  } finally { await p.close(); }
  assert.equal(await p.refresh(...signed(config(3))), false);
  await assert.rejects(() => p.choose("layout", "a".repeat(64)));
});

test("signed weighted assignments are stable across independent release domains", async () => {
  const first = await createExperimentProvider({ publicKey: keys.publicKey, domain: "provider-blue", clock: () => 101 });
  const second = await createExperimentProvider({ publicKey: keys.publicKey, domain: "provider-green", clock: () => 101 });
  try {
    const payload = config(); payload.experiments[0].weights = [0.5, 0.5];
    await first.refresh(...signed(payload)); await second.refresh(...signed(payload));
    const variants = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const key = i.toString(16).padStart(64, "0");
      const a = await first.choose("layout", key), b = await second.choose("layout", key);
      assert.equal(a, b); variants.add(a);
    }
    assert.equal(variants.size, 2);
  } finally { await first.close(); await second.close(); }
});

test("trust configuration must be an explicit public Ed25519 key and named domain", async () => {
  await assert.rejects(() => createExperimentProvider({ publicKey: keys.privateKey, domain: "provider-key" }));
  await assert.rejects(() => createExperimentProvider({ publicKey: keys.publicKey, domain: "" }));
});

for (const change of ["expiry", "replace", "disable", "close"] as const) {
  test(`pending evaluation refuses a treatment after ${change}`, async t => {
    const { OpenFeature } = await import("@openfeature/server-sdk");
    let now = 101, release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const domain = `provider-race-${change}`;
    const client = OpenFeature.getClient(domain);
    const evaluate = client.getStringDetails.bind(client);
    t.mock.method(OpenFeature, "getClient", () => client);
    t.mock.method(client, "getStringDetails", async (...args: Parameters<typeof evaluate>) => {
      const value = await evaluate(...args);
      entered(); await waiting; return value;
    });
    const p = await createExperimentProvider({ publicKey: keys.publicKey, domain, clock: () => now });
    try {
      await p.refresh(...signed(config()));
      const state = await createExperimentState({ secret: new Uint8Array(32).fill(97) })("", null, p.definitions());
      const choice = state.evaluate("layout", key => p.choose("layout", key));
      await started;
      if (change === "expiry") now = 200;
      else if (change === "close") await p.close();
      else {
        const next = config(2);
        if (change === "disable") next.experiments[0].disabled = true;
        assert.equal(await p.refresh(...signed(next)), true);
      }
      release();
      assert.equal((await choice).variant, "control");
      assert.equal(state.assignmentKeyVersion("layout"), null);
    } finally { release(); await p.close(); }
  });
}
