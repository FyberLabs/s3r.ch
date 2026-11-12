import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { loadStartupExistingKey, proveStartupKey } from "./startup-existing-key";
import { selectMeshKeyBySea, type PlaintextMeshKeyRecord } from "./idb";
import type { SeaPair } from "./sea";
import vector from "./vectors/forums.json";
const address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const pair: SeaPair = { pub: vector.seaPubkey, priv: "unit-only", epub: "unit-only", epriv: "unit-only" };
const record: PlaintextMeshKeyRecord = { address, seaPub: pair.pub, seaPair: pair, walletSignature: "existing-link", signedPayload: "existing-link" };

test("SEA lookup preserves the existing record and refuses missing or ambiguous keys", () => {
  assert.equal(selectMeshKeyBySea([record], pair.pub), record);
  for (const rows of [[], [record, record], Array(65).fill(record), [{ ...record, seaPub: "other" }]]) {
    assert.equal(selectMeshKeyBySea(rows, pair.pub), null);
  }
  assert.equal(selectMeshKeyBySea([record], "not-a-key"), null);
});

test("selected linked wallet only locates the existing SEA key; it never creates one", async () => {
  let held: SeaPair | null = null, revision = 0, reads = 0, finds = 0;
  const source = { prove: async () => true, read: async (selected: string) => { reads++; assert.equal(selected, address); return record; },
    find: async (pub: string) => { finds++; assert.equal(pub, pair.pub); return record; },
    unlocked: () => held, revision: () => revision,
    remember: (selected: string, value: SeaPair) => { assert.equal(selected, address); assert.equal(value, pair); held = value; revision++; } };
  assert.deepEqual(await loadStartupExistingKey(pair.pub, address, source), { state: "ready", address });
  assert.equal(reads, 1); assert.equal(finds, 0); assert.equal(held, pair);
  assert.deepEqual(await loadStartupExistingKey(pair.pub, null, source), { state: "ready", address });
  assert.equal(finds, 1);
});

test("missing key, conflicting active account and a lock during disk lookup refuse", async () => {
  let revision = 0;
  const base = { prove: async () => true, read: async () => record, find: async () => record, unlocked: () => null,
    revision: () => revision, remember: () => assert.fail("must not import a key") };
  assert.deepEqual(await loadStartupExistingKey(pair.pub, address, { ...base, read: async () => null }), { state: "missing" });
  assert.deepEqual(await loadStartupExistingKey(pair.pub, address, { ...base, read: async () => ({ ...record, seaPub: "other" }) }), { state: "conflict" });
  assert.deepEqual(await loadStartupExistingKey(pair.pub, address, { ...base, unlocked: () => ({ ...pair, pub: "other" }) }), { state: "conflict" });
  assert.deepEqual(await loadStartupExistingKey(pair.pub, address, { ...base, read: async () => { revision++; return record; } }), { state: "locked" });
  assert.deepEqual(await loadStartupExistingKey(pair.pub, address, { ...base, read: async () => { throw Error("offline"); } }), { state: "missing" });
});


test("key proof failure and a lock during proof never import the disk key", async () => {
  let revision = 0;
  const base = { read: async () => record, find: async () => record, unlocked: () => null,
    revision: () => revision, remember: () => assert.fail("must not import a key"), prove: async () => false };
  assert.deepEqual(await loadStartupExistingKey(pair.pub, address, base), { state: "conflict" });
  assert.deepEqual(await loadStartupExistingKey(pair.pub, address, { ...base, prove: async () => { revision++; return true; } }), { state: "locked" });
});

 test("local proof verifies possession rather than trusting the stored public label", async () => {
  const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
  const saved = await sea.pair(), other = await sea.pair();
  assert.equal(await proveStartupKey(saved), true);
  assert.equal(await proveStartupKey({ ...other, pub: saved.pub }), false);
  assert.equal(await proveStartupKey({ ...saved, priv: "invalid" }), false);
});
