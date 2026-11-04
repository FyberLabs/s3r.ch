import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { seaToPrincipalKey } from "./identity/forum-check";
import { createForumAuthoritySnapshotStore } from "./forum-authority-store";
import type { InventoryStore } from "./delegation-inventory";
import type { ForumAuthoritySnapshot } from "./identity/forum-authority";
const key = p256.getPublicKey(new Uint8Array(32).fill(53), false);
const owner = Buffer.from(key.slice(1,33)).toString("base64url") + "." + Buffer.from(key.slice(33)).toString("base64url");
const squad = { owner, forumId: `forum_${seaToPrincipalKey(owner)}_${"a".repeat(32)}`, label: "Storage test" };
const snapshot = (): ForumAuthoritySnapshot => ({ completeThrough: 100, rows: [{ kind: "cancel", soul: "storage-fixture", record: { evidence: "cancel" } }], history: { completeThrough: 100, links: [{ evidence: "link" }],
  accounts: [{ principal: owner, rotations: [{ evidence: "rotation" }], revocations: [{ evidence: "revoke" }], genesisEpubBindings: [{ evidence: "genesis" }] }] } });
// Storage fixtures intentionally do not claim cryptographic authority.
function setup() {
  let held: { text: string; etag: string } | null = null, version = 0;
  const store: InventoryStore = { read: async () => held && { ...held }, compareAndSwap: async (etag, text) => {
    if (etag !== (held?.etag ?? null)) return false;
    held = { text, etag: String(++version) }; return true;
  } };
  return { store, a: createForumAuthoritySnapshotStore(store, squad), b: createForumAuthoritySnapshotStore(store, squad) };
}
test("one conditional document atomically replaces history and ACL with no stale overwrite", async () => {
  const { a, b } = setup(); await a.initialize(snapshot()); const old = await a.load();
  const next = { ...old.snapshot, completeThrough: 101, history: { ...old.snapshot.history, completeThrough: 101 } };
  assert.deepEqual((await Promise.all([a.replace(old.etag, next), b.replace(old.etag, next)])).sort(), [false, true]);
  assert.deepEqual(await b.read(101, new AbortController().signal), next);
  assert.equal(await a.replace(old.etag, snapshot()), false);
  await assert.rejects(a.initialize(snapshot()));
  await assert.rejects(b.read(102, new AbortController().signal), /incomplete/);
});
test("updates cannot discard historical recovery evidence or regress horizons", async () => {
  const { a } = setup(); await a.initialize(snapshot()); const old = await a.load();
  await assert.rejects(a.replace(old.etag, { ...old.snapshot, rows: [] }), /removed/);
  for (const field of ["rotations", "revocations", "genesisEpubBindings"] as const) {
    const next = structuredClone(old.snapshot); (next.history.accounts[0] as unknown as Record<string, unknown>)[field] = [];
    await assert.rejects(a.replace(old.etag, next), /removed/);
  }
  await assert.rejects(a.replace(old.etag, { ...old.snapshot, history: { ...old.snapshot.history, links: [] } }), /removed/);
  await assert.rejects(a.replace(old.etag, { ...old.snapshot, history: { ...old.snapshot.history, accounts: [] } }), /removed/);
  await assert.rejects(a.replace(old.etag, { ...old.snapshot, completeThrough: 99 }), /regressed/);
  assert.deepEqual(await a.load(), old);
});
test("missing, wrong-scope, corrupt and aborted storage reads never create authority", async () => {
  const { a, store } = setup(); await assert.rejects(a.read(100, new AbortController().signal), /missing/);
  await a.initialize(snapshot());
  const other = createForumAuthoritySnapshotStore(store, { ...squad, forumId: squad.forumId.replace(/a{32}$/, "b".repeat(32)) });
  await assert.rejects(other.load(), /scope/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(a.read(100, controller.signal));
  const held = (await store.read())!; await store.compareAndSwap(held.etag, "{}"); await assert.rejects(a.load());
});
