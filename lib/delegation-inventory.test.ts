import assert from "node:assert/strict";
import { test } from "node:test";
import { createDelegationInventory, type InventoryStore } from "./delegation-inventory";
const destination = (n: number) => `need_p_${"1".repeat(128)}_${n.toString(16).padStart(32, "0")}`;
const op = "a".repeat(32);
function backend() {
  let current: { text: string; etag: string } | null = null, revision = 0;
  const store: InventoryStore = {
    async read() { return current && { ...current }; },
    async compareAndSwap(expected, text) {
      if ((current?.etag ?? null) !== expected) return false;
      current = { text, etag: String(++revision) }; return true;
    },
  };
  return store;
}
for (const freezeFirst of [true, false]) test(`concurrent registration and freeze cannot omit accepted destination (${freezeFirst})`, async () => {
  const store = backend(), a = createDelegationInventory(store), b = createDelegationInventory(store);
  await a.initialize([]);
  const tasks = freezeFirst ? [a.freeze(op), b.register(destination(1))] : [b.register(destination(1)), a.freeze(op)];
  const results = await Promise.allSettled(tasks);
  const registered = results[freezeFirst ? 1 : 0].status === "fulfilled";
  const frozen = await a.load();
  assert.equal(frozen.operation, op);
  assert.equal(frozen.destinations.includes(destination(1)), registered);
  await assert.rejects(b.register(destination(2)), /frozen/);
});
test("two cancellation operations compete for one persistent inventory", async () => {
  const store = backend(), a = createDelegationInventory(store), b = createDelegationInventory(store);
  await a.initialize([destination(1)]);
  const results = await Promise.allSettled([a.freeze(op), b.freeze("b".repeat(32))]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const recovered = createDelegationInventory(store), saved = await recovered.load();
  assert.deepEqual(await recovered.freeze(saved.operation!), saved);
  await assert.rejects(recovered.initialize([]));
  assert.deepEqual(await recovered.load(), saved);
});
test("lost freeze response stays frozen across coordinator restart", async () => {
  const store = backend(); await createDelegationInventory(store).initialize([destination(1)]);
  const broken = createDelegationInventory({ ...store, async compareAndSwap(etag, text) {
    const applied = await store.compareAndSwap(etag, text); assert.ok(applied); throw Error("response lost");
  } });
  await assert.rejects(broken.freeze(op), /response lost/);
  const recovered = createDelegationInventory(store);
  assert.equal((await recovered.freeze(op)).operation, op);
  await assert.rejects(recovered.register(destination(2)), /frozen/);
});
test("missing, corrupt and exhausted storage fails closed without empty inventory", async () => {
  const a = createDelegationInventory(backend()); await assert.rejects(a.freeze(op), /missing/);
  for (const saved of [{ etag: "1", text: "{}" }, { etag: "*", text: "{}" }]) {
    const bad = createDelegationInventory({ async read() { return saved; }, async compareAndSwap() { throw Error("must not write"); } });
    await assert.rejects(bad.freeze(op));
  }
  const store = backend(); await createDelegationInventory(store).initialize([]);
  let attempts = 0;
  const busy = createDelegationInventory({ ...store, async compareAndSwap() { attempts++; return false; } });
  await assert.rejects(busy.freeze(op), /contention/); assert.equal(attempts, 8);
});
test("capacity preserves every destination and caller mutation cannot alter state", async () => {
  const store = backend(), a = createDelegationInventory(store), items = Array.from({ length: 256 }, (_, i) => destination(i));
  const pending = a.initialize(items); items.length = 0; await pending;
  await assert.rejects(a.register(destination(999)), /invalid destination/);
  const frozen = await a.freeze(op);
  assert.equal(frozen.destinations.length, 256); assert.ok(Object.isFrozen(frozen.destinations));
});
