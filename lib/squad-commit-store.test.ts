import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createSquadCommitStore } from "./squad-commit-store";
import { createDelegationRuntime } from "./delegation-runtime";
import { parseForumAuthority } from "./identity/forum-authority-records";
import { createAssignmentJournal } from "./delegation-journal";
import { seaToPrincipalKey } from "./identity/forum-check";
import type { InventoryStore } from "./delegation-inventory";
const pub = (n: number) => { const k = p256.getPublicKey(new Uint8Array(32).fill(n), false); return Buffer.from(k.slice(1,33)).toString("base64url") + "." + Buffer.from(k.slice(33)).toString("base64url"); };
const owner = pub(53), old = pub(54), replacement = pub(55);
const forum = `forum_${seaToPrincipalKey(owner)}_${"a".repeat(32)}`;
const spec = { forumId: forum, owner, label: "Combined storage" };
const history = { completeThrough: 100, links: [], accounts: [{ principal: owner, rotations: [], revocations: [], genesisEpubBindings: [] }] };
function memory(): InventoryStore {
  let value: { text: string; etag: string } | null = null, rev = 0;
  return { read: async () => value && { ...value }, compareAndSwap: async (etag, text) => {
    if (etag !== (value?.etag ?? null)) return false; value = { text, etag: String(++rev) }; return true;
  } };
}
async function setup() {
  const seed = createAssignmentJournal(memory(), () => 100);
  const journal = await seed.initialize({ forum, owner, assignee: old, destinations: [forum], rows: [] });
  const backing = memory(), source = createSquadCommitStore(backing, spec, () => 100);
  await source.initialize(journal, history);
  return { source, backing };
}
test("history update fences a previously verified journal view and increments client revision", async () => {
  const { source } = await setup(), view = await source.open(), before = await source.load();
  assert.deepEqual(await view.history(100), history);
  assert.equal(await source.updateHistory(before.etag, { ...history, completeThrough: 101 }), true);
  await assert.rejects(view.journal.claim(owner, "a".repeat(32), replacement, 0), /changed/);
  await assert.rejects(view.journal.load(), /invalid/);
  const fresh = await source.open();
  assert.equal((await fresh.journal.load()).revision, 1);
  await assert.rejects(fresh.journal.claim(owner, "b".repeat(32), replacement, 0), /conflict/);
  await fresh.journal.claim(owner, "b".repeat(32), replacement, 1);
  assert.equal((await source.load()).journal.operation?.id, "b".repeat(32));
});
test("journal commit fences concurrent history importer and preserves one atomic read", async () => {
  const { source, backing } = await setup(), before = await source.load(), view = await source.open();
  await view.journal.claim(owner, "a".repeat(32), replacement, 0);
  assert.equal(await source.updateHistory(before.etag, { ...history, completeThrough: 101 }), false);
  const restarted = createSquadCommitStore(backing, spec, () => 100);
  assert.equal((await restarted.load()).journal.operation?.id, "a".repeat(32));
  assert.deepEqual(await restarted.read(100, new AbortController().signal), { completeThrough: 100, history, rows: [] });
  await assert.rejects(restarted.read(101, new AbortController().signal), /incomplete/);
});
test("history evidence cannot be dropped and missing combined storage cannot reset", async () => {
  const { source } = await setup(); const before = await source.load();
  await assert.rejects(source.updateHistory(before.etag, { ...history, accounts: [] }), /removed/);
  await assert.rejects(source.initialize(before.journal, before.history), /already/);
  const missing = createSquadCommitStore(memory(), spec);
  await assert.rejects(missing.open(), /missing/);
});

test("actual runtime cannot claim an assignment after its verified history is superseded", async () => {
  const seed = createAssignmentJournal(memory(), () => 100);
  const record = { object: forum, owner, issuedAt: 99, sig: "pending" };
  const parsed = parseForumAuthority("object", record)!;
  record.sig = Buffer.from(p256.sign(parsed.bytes, new Uint8Array(32).fill(53), { prehash: true, format: "compact" })).toString("base64url");
  const journal = await seed.initialize({ forum, owner, assignee: old, destinations: [forum], rows: [{ kind: "object", soul: parsed.soul, record }] });
  const source = createSquadCommitStore(memory(), spec, () => 100); await source.initialize(journal, history);
  const view = await source.open(); let changed = false;
  const runtime = createDelegationRuntime({ ...view, clock: () => 100,
    config: { keys: [], policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIssuers: [] },
    history: async at => {
      if (!changed) { changed = true; const before = await source.load(); await source.updateHistory(before.etag, { ...history, completeThrough: 101 }); }
      return view.history(at);
    },
    sign: async () => { throw Error("must not sign a stale assignment"); },
    operationStores: () => { throw Error("must not prepare a stale assignment"); },
  });
  await assert.rejects(runtime.start(owner, "a".repeat(32), replacement, 0), /changed/);
  assert.equal((await source.load()).journal.operation, null);
});

test("lost acknowledgement poisons only the request view and durable state is recoverable", async () => {
  const { source, backing } = await setup();
  const unreliable = createSquadCommitStore({ read: backing.read, compareAndSwap: async (etag, text) => {
    await backing.compareAndSwap(etag, text); throw Error("lost acknowledgement");
  } }, spec, () => 100);
  const view = await unreliable.open();
  await assert.rejects(view.journal.claim(owner, "c".repeat(32), replacement, 0), /lost acknowledgement/);
  await assert.rejects(view.history(100), /unavailable/);
  assert.equal((await source.load()).journal.operation?.id, "c".repeat(32));
  assert.equal((await (await source.open()).journal.load()).operation?.id, "c".repeat(32));
});

test("request cancellation guards every journal CAS and invalidates a rejected view", async () => {
  const { source } = await setup(), controller = new AbortController();
  const pinned = await source.open(() => controller.signal.throwIfAborted());
  await pinned.journal.load(); controller.abort();
  await assert.rejects(pinned.journal.claim(owner, "e".repeat(32), replacement, 0));
  assert.equal((await source.load()).journal.operation, null);
  await assert.rejects(pinned.journal.load(), /invalid/);
});

test("authoritative primary ledger supplies current completeness without rewriting revision or imported horizons", async () => {
  const { backing, source: imported } = await setup(); let now = 120;
  const ledger = createSquadCommitStore(backing, spec, () => now, "authoritative-ledger");
  const before = await backing.read();
  assert.equal((await ledger.read(now, new AbortController().signal)).history.completeThrough, now);
  assert.deepEqual(await backing.read(), before);
  await assert.rejects(imported.read(now, new AbortController().signal), /unavailable|incomplete/);
  const pinned = await ledger.open(); assert.equal((await pinned.history(now)).completeThrough, now);
  now++;
  await assert.rejects(pinned.history(now), /expired/);
  await assert.rejects(pinned.journal.claim(owner, "e".repeat(32), replacement, 0), /expired/);
  assert.deepEqual(await backing.read(), before);
});

test("ledger read crossing a second and concurrent identity admission cannot authorize a stale mutation", async () => {
  const { backing } = await setup(); let now = 120, delayed = false;
  const ledger = createSquadCommitStore({ ...backing, read: async () => {
    const value = await backing.read(); if (delayed) now++; return value;
  } }, spec, () => now, "authoritative-ledger");
  delayed = true;
  await assert.rejects(ledger.read(now, new AbortController().signal), /expired/);
  delayed = false;
  const pinned = await ledger.open(), current = await ledger.load();
  await ledger.updateHistory(current.etag, { ...current.history, completeThrough: now });
  await assert.rejects(pinned.journal.claim(owner, "f".repeat(32), replacement, 0), /changed/);
});

test("primary authority forwards cancellation to the atomic backing read", async () => {
  const controller = new AbortController(); let received: AbortSignal | undefined;
  const source = createSquadCommitStore({ async read(signal) {
    received = signal;
    return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(Error("cancelled")), { once: true }));
  }, async compareAndSwap() { return false; } }, spec, () => 100);
  const pending = source.read(100, controller.signal); controller.abort();
  await assert.rejects(pending, /cancelled/); assert.equal(received, controller.signal);
});
