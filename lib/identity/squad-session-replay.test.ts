import assert from "node:assert/strict";
import test from "node:test";
import { createSquadSessionReplayStore } from "./squad-session-replay";
import type { InventoryStore } from "../delegation-inventory";
test("independent instances atomically consume once and preserve replay evidence across restart", async () => {
  let value: { text: string; etag: string } | null = null, revision = 0, now = 100;
  const store: InventoryStore = { read: async () => value ? { ...value } : null,
    compareAndSwap: async (etag, text) => { if (etag !== (value?.etag ?? null)) return false; value = { text, etag: String(++revision) }; return true; } };
  const a = createSquadSessionReplayStore(store, () => now), b = createSquadSessionReplayStore(store, () => now);
  assert.deepEqual((await Promise.all([a("a".repeat(64), 160), b("a".repeat(64), 160)])).sort(), [false, true]);
  assert.equal(await createSquadSessionReplayStore(store, () => now)("a".repeat(64), 160), false);
  now = 160; assert.equal(await a("b".repeat(64), 220), true);
  assert.equal(await b("a".repeat(64), 160), false);
});
test("corrupt storage and exhausted CAS retries cannot authorize exchange", async () => {
  const bad = createSquadSessionReplayStore({ read: async () => ({ text: "{}", etag: "1" }), compareAndSwap: async () => { throw Error("must not overwrite"); } }, () => 100);
  assert.equal(await bad("a".repeat(64), 160), false);
  let attempts = 0;
  const racing = createSquadSessionReplayStore({ read: async () => null, compareAndSwap: async () => { attempts++; return false; } }, () => 100);
  assert.equal(await racing("a".repeat(64), 160), false); assert.equal(attempts, 4);
});
