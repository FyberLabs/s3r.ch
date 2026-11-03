import assert from "node:assert/strict";
import { test } from "node:test";
import { p256 } from "@noble/curves/nist.js";
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
const group = () => [
  sign("membership", { role: "member", predicate: "same-group", set, member: agent, setOwner: owner, stated: 1, hamState: 1, cancels: [] }, 2),
  sign("membership", { role: "set", predicate: "same-group", set, member: agent, setOwner: owner, stated: 1, hamState: 1, cancels: [] }),
  sign("object-set", { owner, object: destination, predicate: "same-group", set, stated: 1, hamState: 1, cancels: [] }),
];
async function harness(destinations = [destination], subject = agent) {
  let state: { text: string; etag: string } | null = null, revision = 0, now = at;
  const inventory = createDelegationInventory({ async read() { return state; }, async compareAndSwap(etag, text) {
    if ((state?.etag ?? null) !== etag) return false; state = { text, etag: String(++revision) }; return true;
  } });
  await inventory.initialize(destinations); await inventory.freeze(operationId);
  const records = [grant("post", 0, 2, destination, subject), grant("see", 0, 2, destination, subject)];
  const documents = new Map<string, string>();
  const outbox = createInventoryBoundOutbox(inventory, createCancellationOutbox({ async read(id) { return documents.get(id) ?? null; }, async create(id, text) { if (!documents.has(id)) documents.set(id, text); } }), { forum, agent: subject });
  await outbox.prepare(operationId, records.map(r => ({ kind: r.kind, soul: r.soul, recordJson: JSON.stringify(r.record) })));
  let snapshot: ForumAuthoritySnapshot = { completeThrough: at, rows: [ownership(), ...records],
    history: { completeThrough: at, links: [], accounts: [owner, agent].map(principal => ({ principal, rotations: [], revocations: [], genesisEpubBindings: [] })) } };
  const config = { keys: vectors.context.jwks.keys as ForumWitnessKey[], policy: vectors.context.policy, pinnedIssuers: vectors.context.pinnedIss };
  const reconciler = createCancellationReconciler({ inventory, outbox, config, clock: () => now, source: async () => snapshot });
  return { reconciler, records, outbox, inventory, config, documents, get snapshot() { return snapshot; }, set snapshot(value) { snapshot = value; }, tick() { now++; } };
}
test("exact verified cancellations reconcile only ACL access, not worker completion", async () => {
  const h = await harness();
  const result = await h.reconciler.reconcile(operationId);
  assert.ok(result.ok, JSON.stringify(result)); assert.equal(result.status, "acl-reconciled");
  assert.equal(result.evaluatedAt, at); assert.equal("workerDrained" in result, false);
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
