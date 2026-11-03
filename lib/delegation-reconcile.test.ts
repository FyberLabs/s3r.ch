import assert from "node:assert/strict";
import { test } from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createReplacementGrantOutbox } from "./delegation-replacement-grants";
import { createCancellationReconciler } from "./delegation-reconcile";
import { createDelegationInventory } from "./delegation-inventory";
import { createCancellationOutbox } from "./delegation-outbox";
import { createInventoryBoundOutbox } from "./delegation-bound-outbox";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { seaToPrincipalKey } from "./identity/forum-check";
import type { ForumAuthoritySnapshot } from "./identity/forum-authority";
import type { ForumWitnessKey } from "./identity/forum-witness-verification";
import vectors from "./identity/vectors/forum-authority.json";
const secret = (n: number) => { const b = new Uint8Array(32); b[31] = n; return b; };
const pub = (n: number) => { const k = p256.getPublicKey(secret(n), false); return Buffer.from(k.slice(1, 33)).toString("base64url") + "." + Buffer.from(k.slice(33)).toString("base64url"); };
const owner = pub(1), agent = pub(2), at = 1700000060, operationId = "a".repeat(32);
const object = (kind: string, tail = "1") => `${kind}_${seaToPrincipalKey(owner)}_${tail.repeat(32)}`;
const forum = object("forum"), destination = object("need"), set = object("set");
type Row = ForumAuthoritySnapshot["rows"][number];
function sign(kind: AuthorityKind, fields: object, key = 1): Row {
  const record = { issuedAt: at - 10, ...fields, sig: "pending" };
  const parsed = parseForumAuthority(kind, record); assert.ok(parsed);
  record.sig = Buffer.from(p256.sign(parsed.bytes, secret(key), { prehash: true, format: "compact" })).toString("base64url");
  return { kind, soul: parsed.soul, record };
}
const ownership = (target = destination) => sign("object", { owner, object: target });
const grant = (kind: "see" | "post", stated = 0, hamState = 2, target = destination, accessor = agent) =>
  sign(kind, { owner, object: target, accessor, stated, hamState, from: at - 20, until: at + 100 });
const group = (member = agent, key = 2) => [
  sign("membership", { role: "member", predicate: "same-group", set, member, setOwner: owner, stated: 1, hamState: 1, cancels: [] }, key),
  sign("membership", { role: "set", predicate: "same-group", set, member, setOwner: owner, stated: 1, hamState: 1, cancels: [] }),
  sign("object-set", { owner, object: destination, predicate: "same-group", set, stated: 1, hamState: 1, cancels: [] }),
];
async function harness(destinations = [destination], subject = agent, replacement?: string) {
  let state: { text: string; etag: string } | null = null, revision = 0, now = at;
  const inventory = createDelegationInventory({ async read() { return state; }, async compareAndSwap(etag, text) {
    if ((state?.etag ?? null) !== etag) return false; state = { text, etag: String(++revision) }; return true;
  } });
  await inventory.initialize(destinations); await inventory.freeze(operationId);
  const records = [grant("post", 0, 2, destination, subject), grant("see", 0, 2, destination, subject)];
  const documents = new Map<string, string>();
  const outbox = createInventoryBoundOutbox(inventory, createCancellationOutbox({ async read(id) { return documents.get(id) ?? null; }, async create(id, text) { if (!documents.has(id)) documents.set(id, text); } }), { forum, agent: subject });
  const envelopes = records.map(r => ({ kind: r.kind, soul: r.soul, recordJson: JSON.stringify(r.record) }));
  if (replacement) await outbox.prepareReassignment(operationId, replacement, envelopes);
  else await outbox.prepare(operationId, envelopes);
  let snapshot: ForumAuthoritySnapshot = { completeThrough: at, rows: [ownership(), ...records],
    history: { completeThrough: at, links: [], accounts: [owner, agent].map(principal => ({ principal, rotations: [], revocations: [], genesisEpubBindings: [] })) } };
  const config = { keys: vectors.context.jwks.keys as ForumWitnessKey[], policy: vectors.context.policy, pinnedIssuers: vectors.context.pinnedIss };
  const reconciler = createCancellationReconciler({ inventory, outbox, config, clock: () => now, source: async () => snapshot });
  return { reconciler, records, outbox, inventory, config, documents, get snapshot() { return snapshot; }, set snapshot(value) { snapshot = value; }, tick() { now++; } };
}
test("exact verified cancellations reconcile ACL access without completing reassignment", async () => {
  const h = await harness();
  const result = await h.reconciler.reconcile(operationId);
  assert.ok(result.ok, JSON.stringify(result)); assert.equal(result.status, "acl-reconciled");
  assert.equal(result.evaluatedAt, at); assert.equal("assignmentComplete" in result, false);
});
for (const path of ["post", "see", "group"] as const) test(`surviving ${path} access blocks reconciliation`, async () => {
  const h = await harness(); h.snapshot = { ...h.snapshot, rows: [...h.snapshot.rows, ...(path === "group" ? group() : [grant(path, 1, 3)])] };
  assert.deepEqual(await h.reconciler.reconcile(operationId), { ok: false, reason: "access-remains" });
});
test("an absent saved cancellation cannot be replaced by missing grant state", async () => {
  const h = await harness(); h.snapshot = { ...h.snapshot, rows: [ownership(), h.records[0]] };
  assert.deepEqual(await h.reconciler.reconcile(operationId), { ok: false, reason: "missing-exact-cancellation" });
});
test("every frozen destination requires ownership evidence", async () => {
  const h = await harness([destination, object("need", "2")]);
  assert.deepEqual(await h.reconciler.reconcile(operationId), { ok: false, reason: "missing-destination-authority" });
});
test("an agent's ownership cannot be revoked by canceling grants", async () => {
  const h = await harness([destination], owner);
  assert.deepEqual(await h.reconciler.reconcile(operationId), { ok: false, reason: "access-remains" });
});
test("forged evidence and incomplete history never establish cancellation", async () => {
  const h = await harness(), original = h.snapshot;
  h.snapshot = { ...original, rows: [...original.rows, { ...h.records[0], record: { ...(h.records[0].record as object), sig: "forged" } }] };
  assert.deepEqual(await h.reconciler.reconcile(operationId), { ok: false, reason: "unverified-authority" });
  h.snapshot = { ...original, history: { ...original.history, completeThrough: at - 1 } };
  assert.deepEqual(await h.reconciler.reconcile(operationId), { ok: false, reason: "unverified-authority" });
});
test("clock expiry during final storage verification invalidates the result", async () => {
  const h = await harness(); let loads = 0;
  const r = createCancellationReconciler({ inventory: h.inventory, config: h.config, clock: () => at + (loads > 1 ? 1 : 0), source: async () => h.snapshot,
    outbox: { async load(id) { loads++; return h.outbox.load(id); } } });
  assert.deepEqual(await r.reconcile(operationId), { ok: false, reason: "stale-evaluation" });
});
test("storage loss after proof verification cannot return success", async () => {
  const h = await harness(); let loads = 0;
  const r = createCancellationReconciler({ inventory: h.inventory, config: h.config, clock: () => at, source: async () => h.snapshot,
    outbox: { async load(id) { if (++loads > 1) h.documents.clear(); return h.outbox.load(id); } } });
  assert.deepEqual(await r.reconcile(operationId), { ok: false, reason: "operation-changed" });
});

const replacement = pub(3);
async function reassignmentHarness(window?: { from: number; until: number }) {
  const h = await harness([destination], agent, replacement);
  const documents = new Map<string, string>();
  const plans = createReplacementGrantOutbox({ inventory: h.inventory, outbox: h.outbox,
    store: { async read(id) { return documents.get(id) ?? null; }, async create(id, text) { if (!documents.has(id)) documents.set(id, text); } } });
  const grants = (["post", "see"] as const).map(kind => {
    const row = grant(kind, 1, 4, destination, replacement);
    return window ? sign(kind, { ...row.record as object, ...window }) : row;
  });
  const plan = await plans.prepare(operationId, replacement, grants.map(r => ({ kind: r.kind, soul: r.soul, recordJson: JSON.stringify(r.record) })));
  h.snapshot = { ...h.snapshot, rows: [...h.snapshot.rows, ...grants], history: { ...h.snapshot.history,
    accounts: [...h.snapshot.history.accounts, { principal: replacement, rotations: [], revocations: [], genesisEpubBindings: [] }] } };
  const input = { inventory: h.inventory, outbox: h.outbox, replacementGrants: plans, config: h.config, clock: () => at, source: async () => h.snapshot };
  return { h, plans, plan, grants, documents, input, reconciler: createCancellationReconciler(input) };
}
test("reassignment checks old and replacement access in one authenticated snapshot", async () => {
  const r = await reassignmentHarness(); let calls = 0;
  const reconciler = createCancellationReconciler({ ...r.input, source: async () => { calls++; return r.h.snapshot; } });
  const result = await reconciler.reconcileReassignment(operationId, replacement);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.status, "reassignment-access-reconciled");
  if (result.status === "reassignment-access-reconciled") { assert.equal(result.replacement, replacement); assert.equal(result.checkedGrants, 2); }
  assert.equal(calls, 1); assert.equal("assignmentComplete" in result, false);
});
test("partial replacement publication cannot pass on old-access cancellation alone", async () => {
  const r = await reassignmentHarness();
  r.h.snapshot = { ...r.h.snapshot, rows: r.h.snapshot.rows.filter(row => row !== r.grants[1]) };
  assert.equal((await r.reconciler.reconcile(operationId)).ok, true);
  assert.deepEqual(await r.reconciler.reconcileReassignment(operationId, replacement), { ok: false, reason: "missing-exact-replacement-grant" });
});
for (const kind of ["see", "post"] as const) test(`a newer ${kind} cancellation blocks replacement access`, async () => {
  const r = await reassignmentHarness();
  r.h.snapshot = { ...r.h.snapshot, rows: [...r.h.snapshot.rows, grant(kind, 0, 5, destination, replacement)] };
  assert.deepEqual(await r.reconciler.reconcileReassignment(operationId, replacement), { ok: false, reason: "replacement-access-missing" });
});
test("a different effective grant cannot replace exact saved evidence", async () => {
  const r = await reassignmentHarness();
  r.h.snapshot = { ...r.h.snapshot, rows: [...r.h.snapshot.rows.filter(row => row !== r.grants[0]), grant("post", 1, 6, destination, replacement)] };
  assert.deepEqual(await r.reconciler.reconcileReassignment(operationId, replacement), { ok: false, reason: "missing-exact-replacement-grant" });
});
test("surviving old-assignee access blocks otherwise valid replacement grants", async () => {
  const r = await reassignmentHarness(); r.h.snapshot = { ...r.h.snapshot, rows: [...r.h.snapshot.rows, ...group()] };
  assert.deepEqual(await r.reconciler.reconcileReassignment(operationId, replacement), { ok: false, reason: "access-remains" });
});
test("forged replacement evidence and missing owner history fail closed", async () => {
  const r = await reassignmentHarness(), original = r.h.snapshot;
  r.h.snapshot = { ...original, rows: original.rows.map(row => row === r.grants[0] ? { ...row, record: { ...row.record as object, sig: "forged" } } : row) };
  assert.deepEqual(await r.reconciler.reconcileReassignment(operationId, replacement), { ok: false, reason: "unverified-authority" });
  // Missing owner history invalidates both grants and their object authority.
  r.h.snapshot = { ...original, history: { ...original.history, accounts: original.history.accounts.filter(a => a.principal !== owner) } };
  assert.equal((await r.reconciler.reconcileReassignment(operationId, replacement)).ok, false);
});
test("legacy or mismatched intent and missing plans cannot produce reassignment results", async () => {
  const legacy = await harness();
  assert.deepEqual(await legacy.reconciler.reconcileReassignment(operationId, replacement), { ok: false, reason: "replacement-intent-mismatch" });
  const r = await reassignmentHarness();
  assert.deepEqual(await r.reconciler.reconcileReassignment(operationId, pub(4)), { ok: false, reason: "replacement-intent-mismatch" });
  assert.deepEqual(await r.reconciler.reconcileReassignment(operationId, undefined as unknown as string), { ok: false, reason: "invalid-replacement" });
  r.documents.clear();
  assert.deepEqual(await r.reconciler.reconcileReassignment(operationId, replacement), { ok: false, reason: "missing-replacement-plan" });
});
test("plan loss and clock expiry during final checks invalidate replacement results", async () => {
  const r = await reassignmentHarness(); let reads = 0;
  const reconciler = createCancellationReconciler({ ...r.input, replacementGrants: { async load(id, target) {
    if (++reads > 1) r.documents.clear(); return r.plans.load(id, target);
  } } });
  assert.deepEqual(await reconciler.reconcileReassignment(operationId, replacement), { ok: false, reason: "replacement-plan-changed" });
  const fresh = await reassignmentHarness(); reads = 0;
  const expiring = createCancellationReconciler({ ...fresh.input, clock: () => at + (reads > 1 ? 1 : 0),
    replacementGrants: { async load(id, target) { reads++; return fresh.plans.load(id, target); } } });
  assert.deepEqual(await expiring.reconcileReassignment(operationId, replacement), { ok: false, reason: "stale-evaluation" });
});

test("group access cannot substitute for canceled direct replacement read access", async () => {
  const r = await reassignmentHarness();
  r.h.snapshot = { ...r.h.snapshot, rows: [...r.h.snapshot.rows, ...group(replacement, 3), grant("see", 0, 5, destination, replacement)] };
  assert.deepEqual(await r.reconciler.reconcileReassignment(operationId, replacement), { ok: false, reason: "replacement-access-missing" });
});
for (const window of [{ from: at - 20, until: at }, { from: at + 1, until: at + 100 }]) {
  test(`saved replacement windows must be active: ${JSON.stringify(window)}`, async () => {
    const r = await reassignmentHarness(window);
    // Newer effective rows must not disguise an expired/not-yet-active saved plan.
    r.h.snapshot = { ...r.h.snapshot, rows: [...r.h.snapshot.rows,
      grant("post", 1, 8, destination, replacement), grant("see", 1, 8, destination, replacement)] };
    assert.deepEqual(await r.reconciler.reconcileReassignment(operationId, replacement), { ok: false, reason: "replacement-access-missing" });
  });
}
