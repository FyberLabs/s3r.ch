import assert from "node:assert/strict";
import { test } from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createCancellationOutbox } from "./delegation-outbox";
import { createInventoryBoundOutbox } from "./delegation-bound-outbox";
import { type InventoryState } from "./delegation-inventory";
import { seaToPrincipalKey } from "./identity/forum-check";
import { parseForumAuthority } from "./identity/forum-authority-records";
const secret = new Uint8Array(32); secret[31] = 1;
const key = p256.getPublicKey(secret, false);
const agent = Buffer.from(key.slice(1, 33)).toString("base64url") + "." + Buffer.from(key.slice(33)).toString("base64url");
const forum = `forum_${seaToPrincipalKey(agent)}_${"1".repeat(32)}`, id = "a".repeat(32);
function harness() {
  let state: InventoryState = { version: 1, operation: id, destinations: [forum] };
  const documents = new Map<string, string>();
  const inventory = { async load() { return state; } };
  const store = { async read(id: string) { return documents.get(id) ?? null; }, async create(id: string, text: string) { if (!documents.has(id)) documents.set(id, text); } };
  const outbox = createCancellationOutbox(store);
  const row = { owner: agent, object: forum, accessor: agent, stated: 0, from: 0, until: 100, issuedAt: 10, hamState: 11, sig: "pending" };
  const parsed = parseForumAuthority("post", row)!;
  row.sig = Buffer.from(p256.sign(parsed.bytes, secret, { prehash: true, format: "compact" })).toString("base64url");
  const records = [{ kind: "post" as const, soul: parsed.soul, recordJson: JSON.stringify(row) }];
  return { inventory, outbox, store, records, documents, replace(next: InventoryState) { state = next; },
    bound: createInventoryBoundOutbox(inventory, outbox, { forum, agent }) };
}
test("restart recovers exact bytes only under the same frozen scope and inventory", async () => {
  const h = harness(), saved = await h.bound.prepare(id, h.records);
  assert.match(saved.fence, /^[0-9a-f]{64}$/);
  const restart = createInventoryBoundOutbox(h.inventory, createCancellationOutbox(h.store), { forum, agent });
  assert.deepEqual(await restart.load(id), saved);
  assert.deepEqual(await restart.prepare(id, h.records), saved);
  const wrong = createInventoryBoundOutbox(h.inventory, h.outbox, { forum: forum.replace(/1{32}$/, "2".repeat(32)), agent });
  await assert.rejects(wrong.load(id), /binding mismatch/);
  h.replace({ version: 1, operation: id, destinations: [] });
  await assert.rejects(restart.load(id), /binding mismatch/);
});
test("unfrozen and foreign operation inventories cannot save cancellation material", async () => {
  for (const operation of [null, "b".repeat(32)]) {
    const h = harness(); h.replace({ version: 1, operation, destinations: [forum] });
    await assert.rejects(h.bound.prepare(id, h.records), /does not own/);
    assert.equal(h.documents.size, 0);
  }
});
test("caller mutation while inventory loads cannot change signed records or scope", async () => {
  const h = harness(), original = structuredClone(h.records), scope = { forum, agent };
  const bound = createInventoryBoundOutbox({ async load() { h.records[0].recordJson = "{}"; scope.forum = "changed"; return h.inventory.load(); } }, h.outbox, scope);
  const saved = await bound.prepare(id, h.records);
  assert.deepEqual(saved.cancellations, original); assert.equal(saved.forum, forum);
});
test("inventory replacement during persistence fails without deleting recovery bytes", async () => {
  const h = harness();
  const outbox = createCancellationOutbox({ ...h.store, async create(id, text) {
    await h.store.create(id, text); h.replace({ version: 1, operation: id, destinations: [] });
  } });
  await assert.rejects(createInventoryBoundOutbox(h.inventory, outbox, { forum, agent }).prepare(id, h.records), /binding mismatch/);
  assert.equal(h.documents.size, 1);
});
test("lost outbox acknowledgement reconciles through the bound recovery path", async () => {
  const h = harness();
  const failing = createCancellationOutbox({ ...h.store, async create(id, text) { await h.store.create(id, text); throw Error("response lost"); } });
  await assert.rejects(createInventoryBoundOutbox(h.inventory, failing, { forum, agent }).prepare(id, h.records), /response lost/);
  assert.deepEqual((await h.bound.load(id))?.cancellations, h.records);
});

function assignee(n: number) {
  const secret = new Uint8Array(32); secret[31] = n;
  const key = p256.getPublicKey(secret, false);
  return Buffer.from(key.slice(1, 33)).toString("base64url") + "." + Buffer.from(key.slice(33)).toString("base64url");
}
test("reassignment recovery preserves the recipient and exact cancellation bytes", async () => {
  const h = harness(), replacement = assignee(2);
  const saved = await h.bound.prepareReassignment(id, replacement, h.records);
  const restart = createInventoryBoundOutbox(h.inventory, createCancellationOutbox(h.store), { forum, agent });
  assert.equal(saved.replacement, replacement);
  assert.deepEqual(await restart.loadReassignment(id, replacement), saved);
  assert.deepEqual(await restart.prepareReassignment(id, replacement, h.records), saved);
  await assert.rejects(restart.loadReassignment(id, assignee(3)), /mismatched reassignment/);
  await assert.rejects(restart.prepareReassignment(id, assignee(3), h.records), /conflict/);
  await assert.rejects(restart.prepare(id, h.records), /conflict/);
  assert.deepEqual(await restart.load(id), saved);
});
test("competing reassignment recipients cannot replace the first immutable intent", async () => {
  const h = harness();
  const results = await Promise.allSettled([2, 3].map(n => h.bound.prepareReassignment(id, assignee(n), h.records)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const winner = results.find(r => r.status === "fulfilled")!;
  assert.equal(winner.status, "fulfilled");
  if (winner.status === "fulfilled") assert.deepEqual(await h.bound.load(id), winner.value);
});
test("legacy cancellation records cannot acquire reassignment intent on retry", async () => {
  const h = harness(), saved = await h.bound.prepare(id, h.records);
  assert.equal(Object.hasOwn(saved, "replacement"), false);
  await assert.rejects(h.bound.loadReassignment(id, assignee(2)), /missing or mismatched/);
  await assert.rejects(h.bound.prepareReassignment(id, assignee(2), h.records), /conflict/);
  assert.deepEqual(await h.bound.load(id), saved);
});
test("invalid or self replacement is rejected before persistence, including raw records", async () => {
  const h = harness();
  for (const replacement of [agent, "invalid", "", undefined, null]) {
    await assert.rejects(h.bound.prepareReassignment(id, replacement as string, h.records), /invalid replacement/);
    await assert.rejects(h.outbox.prepare({ operationId: id, forum, agent, fence: "test", cancellations: h.records,
      replacement: replacement as string }), /invalid replacement/);
  }
  assert.equal(h.documents.size, 0);
});
test("lost reassignment acknowledgement retains the original recipient", async () => {
  const h = harness(), replacement = assignee(2);
  const failing = createCancellationOutbox({ ...h.store, async create(id, text) { await h.store.create(id, text); throw Error("response lost"); } });
  await assert.rejects(createInventoryBoundOutbox(h.inventory, failing, { forum, agent })
    .prepareReassignment(id, replacement, h.records), /response lost/);
  assert.equal((await h.bound.loadReassignment(id, replacement)).replacement, replacement);
  await assert.rejects(h.bound.prepareReassignment(id, assignee(3), h.records), /conflict/);
});
