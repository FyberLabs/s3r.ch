import assert from "node:assert/strict";
import { test } from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createCancellationOutbox, type CancellationOperation, type CancellationOutboxStore } from "./delegation-outbox";
import { seaToPrincipalKey } from "./identity/forum-check";
import { parseForumAuthority } from "./identity/forum-authority-records";
const secret = new Uint8Array(32); secret[31] = 1;
const key = p256.getPublicKey(secret, false);
const owner = Buffer.from(key.slice(1, 33)).toString("base64url") + "." + Buffer.from(key.slice(33)).toString("base64url");
const object = `forum_${seaToPrincipalKey(owner)}_${"1".repeat(32)}`;
function operation(): CancellationOperation {
  const record = { owner, object, accessor: owner, stated: 0, from: 0, until: 100, issuedAt: 10, hamState: 11, sig: "pending" };
  const parsed = parseForumAuthority("post", record)!;
  record.sig = Buffer.from(p256.sign(parsed.bytes, secret, { prehash: true, format: "compact" })).toString("base64url");
  return { operationId: "a".repeat(32), forum: object, agent: owner, fence: "generation-1",
    cancellations: [{ kind: "post", soul: parsed.soul, recordJson: JSON.stringify(record) }] };
}
// Model only the store's required atomic create semantics. This is not a
// production backend or evidence of cross-device durability/fencing.
function backend() {
  const documents = new Map<string, string>();
  const store: CancellationOutboxStore = {
    async read(id) { return documents.get(id) ?? null; },
    async create(id, text) { if (!documents.has(id)) documents.set(id, text); },
  };
  return { documents, store };
}
test("lost create response recovers exact signed bytes with a new coordinator instance", async () => {
  const { store, documents } = backend(), input = operation();
  const lost = createCancellationOutbox({ ...store, async create(id, text) { await store.create(id, text); throw Error("lost response"); } });
  await assert.rejects(lost.prepare(input), /lost response/);
  const restarted = createCancellationOutbox(store);
  assert.deepEqual(await restarted.load(input.operationId), input);
  assert.deepEqual(await restarted.prepare(input), input);
  assert.equal(documents.size, 1);
});
test("concurrent differing intents cannot replace the winning operation", async () => {
  const { store } = backend(), first = operation(), second = { ...operation(), fence: "generation-2" };
  const results = await Promise.allSettled([createCancellationOutbox(store).prepare(first), createCancellationOutbox(store).prepare(second)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.deepEqual(await createCancellationOutbox(store).load(first.operationId), first);
});
test("lost or corrupt storage never reports prepared; wrong operation ID fails", async () => {
  const input = operation();
  for (const text of [null, "{}", "bad json", JSON.stringify({ ...input, operationId: "b".repeat(32) })]) {
    const outbox = createCancellationOutbox({ async create() {}, async read() { return text; } });
    await assert.rejects(outbox.prepare(input));
  }
});
test("input mutation during persistence cannot change replay material", async () => {
  const { store } = backend(), input = operation(), original = structuredClone(input);
  const outbox = createCancellationOutbox({ ...store, async create(id, text) {
    (input as { fence: string }).fence = "mutated";
    (input.cancellations[0] as { recordJson: string }).recordJson = "{}";
    await store.create(id, text);
  } });
  const saved = await outbox.prepare(input);
  assert.deepEqual(saved, original);
  assert.ok(Object.isFrozen(saved) && Object.isFrozen(saved.cancellations) && Object.isFrozen(saved.cancellations[0]));
});
test("rejects live grants, wrong souls, duplicates, oversized and empty batches before writes", async () => {
  const good = operation(), row = good.cancellations[0];
  const bad = [[], [row, row], [{ ...row, soul: "wrong" }],
    [{ ...row, recordJson: JSON.stringify({ ...JSON.parse(row.recordJson), stated: 1 }) }],
    [{ ...row, recordJson: " ".repeat(32769) }], Array.from({ length: 257 }, () => row)];
  let writes = 0;
  const outbox = createCancellationOutbox({ async read() { return null; }, async create() { writes++; } });
  for (const cancellations of bad) await assert.rejects(outbox.prepare({ ...good, cancellations }));
  assert.equal(writes, 0);
});
test("same-soul cancellations with different signatures/history are retained independently", async () => {
  const { store } = backend(), input = operation(), row = input.cancellations[0];
  const second = { ...row, recordJson: JSON.stringify({ ...JSON.parse(row.recordJson), hamState: 12, sig: "unverified" }) };
  const saved = await createCancellationOutbox(store).prepare({ ...input, cancellations: [row, second] });
  assert.equal(saved.cancellations.length, 2);
  // Structural storage intentionally does not bless signatures or create completion APIs.
  assert.deepEqual(Object.keys(createCancellationOutbox(store)).sort(), ["load", "prepare"]);
});
