import assert from "node:assert/strict";
import { test } from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createReplacementGrantOutbox } from "./delegation-replacement-grants";
import { createCancellationOutbox } from "./delegation-outbox";
import { createInventoryBoundOutbox } from "./delegation-bound-outbox";
import { createDelegationInventory } from "./delegation-inventory";
import { parseForumAuthority } from "./identity/forum-authority-records";
import { seaToPrincipalKey } from "./identity/forum-check";
const secret = (n: number) => { const b = new Uint8Array(32); b[31] = n; return b; };
const pub = (n: number) => { const k = p256.getPublicKey(secret(n), false); return Buffer.from(k.slice(1, 33)).toString("base64url") + "." + Buffer.from(k.slice(33)).toString("base64url"); };
const owner = pub(1), agent = pub(2), replacement = pub(3), id = "a".repeat(32);
const forum = `forum_${seaToPrincipalKey(owner)}_${"1".repeat(32)}`;
const destination = `need_${seaToPrincipalKey(owner)}_${"2".repeat(32)}`;
function envelope(kind: "post" | "see", accessor = replacement, stated = 1, until = 100, object = destination) {
  const record = { owner, object, accessor, stated, from: 1, until, issuedAt: 2, hamState: 3, sig: "pending" };
  const parsed = parseForumAuthority(kind, record)!;
  record.sig = Buffer.from(p256.sign(parsed.bytes, secret(1), { prehash: true, format: "compact" })).toString("base64url");
  return { kind, soul: parsed.soul, recordJson: JSON.stringify(record) };
}
function store() {
  const documents = new Map<string, string>();
  return { documents, async read(id: string) { return documents.get(id) ?? null; },
    async create(id: string, text: string) { if (!documents.has(id)) documents.set(id, text); } };
}
async function harness(legacy = false) {
  let state: { etag: string; text: string } | null = null, revision = 0;
  const inventory = createDelegationInventory({ async read() { return state; }, async compareAndSwap(etag, text) {
    if ((state?.etag ?? null) !== etag) return false; state = { etag: String(++revision), text }; return true;
  } });
  await inventory.initialize([destination]); await inventory.freeze(id);
  const cancellationStore = store(), grantStore = store();
  const outbox = createInventoryBoundOutbox(inventory, createCancellationOutbox(cancellationStore), { forum, agent });
  const cancellations = [envelope("post", agent, 0), envelope("see", agent, 0)];
  if (legacy) await outbox.prepare(id, cancellations);
  else await outbox.prepareReassignment(id, replacement, cancellations);
  const grants = [envelope("post"), envelope("see")];
  const input = { inventory, outbox, store: grantStore };
  return { ...input, cancellationStore, grants, grantsOutbox: createReplacementGrantOutbox(input) };
}
test("restart preserves exact signed replacement grants separately from cancellations", async () => {
  const h = await harness(), original = await h.outbox.load(id);
  assert.equal(await h.grantsOutbox.load(id, replacement), null);
  const saved = await h.grantsOutbox.prepare(id, replacement, h.grants);
  const restarted = createReplacementGrantOutbox(h);
  assert.deepEqual(await restarted.load(id, replacement), saved);
  assert.deepEqual(await restarted.prepare(id, replacement, h.grants), saved);
  assert.deepEqual(saved.grants, h.grants);
  assert.deepEqual(await h.outbox.load(id), original);
  assert.equal("assignmentComplete" in saved, false);
});
test("lost acknowledgement and partial publication retry the same bytes without extending expiry", async () => {
  const h = await harness();
  const failing = createReplacementGrantOutbox({ ...h, store: { ...h.store, async create(id, text) {
    await h.store.create(id, text); throw Error("response lost");
  } } });
  await assert.rejects(failing.prepare(id, replacement, h.grants), /response lost/);
  const recovered = await h.grantsOutbox.load(id, replacement);
  assert.deepEqual(recovered?.grants, h.grants);
  // A publisher may have accepted only the first record. Recovery must retain
  // the entire original batch, not replace it with a shortened/renewed batch.
  await assert.rejects(h.grantsOutbox.prepare(id, replacement, [h.grants[1]]), /conflict/);
  await assert.rejects(h.grantsOutbox.prepare(id, replacement, [envelope("post", replacement, 1, 200), h.grants[1]]), /conflict/);
  assert.deepEqual(await h.grantsOutbox.load(id, replacement), recovered);
});
test("competing grant plans preserve exactly one winner", async () => {
  const h = await harness();
  const results = await Promise.allSettled([100, 200].map(until => h.grantsOutbox.prepare(id, replacement, [envelope("post", replacement, 1, until)])));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const winner = results.find(r => r.status === "fulfilled")!;
  if (winner.status === "fulfilled") assert.deepEqual(await h.grantsOutbox.load(id, replacement), winner.value);
});
test("wrong recipient, destination, polarity, duplicates and legacy intent cannot save grants", async () => {
  const h = await harness();
  for (const grants of [[envelope("post", agent)], [envelope("post", replacement, 1, 100, forum)],
    [envelope("post", replacement, 0)], [h.grants[0], h.grants[0]], []]) {
    await assert.rejects(h.grantsOutbox.prepare(id, replacement, grants));
  }
  await assert.rejects(h.grantsOutbox.prepare(id, pub(4), h.grants), /mismatched/);
  assert.equal(h.store.documents.size, 0);
  const legacy = await harness(true);
  await assert.rejects(legacy.grantsOutbox.prepare(id, replacement, legacy.grants), /mismatched/);
  assert.equal(legacy.store.documents.size, 0);
});
test("caller mutation during binding cannot alter signed retry material", async () => {
  const h = await harness(), original = structuredClone(h.grants);
  const outbox = { async loadReassignment(op: string, target: string) {
    h.grants[0].recordJson = "{}"; return h.outbox.loadReassignment(op, target);
  } };
  const saved = await createReplacementGrantOutbox({ ...h, outbox }).prepare(id, replacement, h.grants);
  assert.deepEqual(saved.grants, original);
});
test("changing cancellation evidence invalidates the bound grant plan", async () => {
  const h = await harness(); await h.grantsOutbox.prepare(id, replacement, h.grants);
  const saved = JSON.parse(h.cancellationStore.documents.get(id)!);
  saved.cancellations[0] = envelope("post", agent, 0, 200);
  h.cancellationStore.documents.set(id, JSON.stringify(saved));
  await assert.rejects(h.grantsOutbox.load(id, replacement), /binding mismatch/);
});
test("operation loss during a grant write fails and preserves recovery bytes", async () => {
  const h = await harness();
  const failing = createReplacementGrantOutbox({ ...h, store: { ...h.store, async create(id, text) {
    await h.store.create(id, text); h.cancellationStore.documents.clear();
  } } });
  await assert.rejects(failing.prepare(id, replacement, h.grants), /missing/);
  assert.equal(h.store.documents.size, 1);
});
test("corrupt or oversized grant documents fail closed", async () => {
  const h = await harness(), saved = await h.grantsOutbox.prepare(id, replacement, h.grants);
  for (const text of ["{", "x".repeat(1_048_577), JSON.stringify({ ...saved, operationId: "b".repeat(32) }),
    JSON.stringify({ ...saved, extra: true }), JSON.stringify({ ...saved, grants: [envelope("see", agent)] })]) {
    h.store.documents.set(id, text);
    await assert.rejects(h.grantsOutbox.load(id, replacement));
  }
});
