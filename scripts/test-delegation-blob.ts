import assert from "node:assert/strict";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { setTimeout as delay } from "node:timers/promises";
import { createBlobCancellationOutboxStore, createBlobReplacementGrantStore } from "../lib/delegation-blob-outbox";
import { createBlobInventoryStore } from "../lib/delegation-blob-inventory";
import { createDelegationInventory } from "../lib/delegation-inventory";
import { p256 } from "@noble/curves/nist.js";
import { createInventoryBoundOutbox } from "../lib/delegation-bound-outbox";
import { createCancellationOutbox } from "../lib/delegation-outbox";
import { seaToPrincipalKey } from "../lib/identity/forum-check";
import { parseForumAuthority } from "../lib/identity/forum-authority-records";
import { createReplacementGrantOutbox } from "../lib/delegation-replacement-grants";
async function main() {
const port = process.argv[2], phase = process.argv[3];
assert.match(port, /^[0-9]+$/); assert.ok(phase === "write" || phase === "read");
const service = () => new BlobServiceClient(`http://127.0.0.1:${port}/outboxtest`,
  new StorageSharedKeyCredential("outboxtest", Buffer.alloc(32, 7).toString("base64")),
  { retryOptions: { maxTries: 1 } });
const container = service().getContainerClient("cancellation-test");
// Synchronize on the emulator accepting requests, including after restart.
const deadline = Date.now() + 15000;
for (;;) {
  try { await container.createIfNotExists({ abortSignal: AbortSignal.timeout(1000) }); break; }
  catch (error) { if (Date.now() >= deadline) throw error; await delay(100); }
}
const scope = "b".repeat(64), id = "a".repeat(32), payload = JSON.stringify({ sig: "exact-签名", attest: "preserved" });
const store = createBlobCancellationOutboxStore(container, scope);
if (phase === "write") {
  assert.equal(await store.read(id), null);
  // Independent clients race on the same immutable operation slot.
  const other = createBlobCancellationOutboxStore(service().getContainerClient("cancellation-test"), scope);
  await Promise.all([store.create(id, payload), other.create(id, payload)]);
  await other.create(id, "replacement");
  const raceId = "d".repeat(32);
  await Promise.all([store.create(raceId, "first"), other.create(raceId, "second")]);
  const winner = await store.read(raceId);
  assert.ok(winner === "first" || winner === "second");
  assert.equal(await other.read(raceId), winner);
  const lostId = "e".repeat(32);
  await assert.rejects((async () => { await store.create(lostId, payload); throw Error("lost acknowledgement"); })());
  assert.equal(await other.read(lostId), payload);
  assert.equal(await store.read(id), payload);
  const isolated = createBlobCancellationOutboxStore(container, "c".repeat(64));
  assert.equal(await isolated.read(id), null);
  await isolated.create(id, "separate");
  assert.equal(await isolated.read(id), "separate");
} else {
  assert.equal(await store.read(id), payload, "new process after emulator restart reads exact bytes");
  assert.equal(await store.read("e".repeat(32)), payload, "lost acknowledgement still left a durable record");
  await store.create(id, "replacement after restart");
  assert.equal(await store.read(id), payload);
}
const inventoryStore = createBlobInventoryStore(container, scope);
const inventory = createDelegationInventory(inventoryStore);
const destination = (n: number) => `need_p_${"1".repeat(128)}_${n.toString(16).padStart(32, "0")}`;
if (phase === "write") {
  await inventory.initialize([destination(0)]);
  const independentStore = createBlobInventoryStore(service().getContainerClient("cancellation-test"), scope);
  const independent = createDelegationInventory(independentStore);
  const stale = await inventoryStore.read(); assert.ok(stale);
  await Promise.all([inventory.register(destination(1)), independent.register(destination(2))]);
  assert.equal((await inventory.load()).destinations.length, 3);
  assert.equal(await inventoryStore.compareAndSwap(stale.etag, stale.text), false, "stale ETag cannot overwrite inventory");
  const results = await Promise.allSettled([inventory.freeze(id), independent.register(destination(3))]);
  assert.equal(results[0].status, "fulfilled");
  const frozen = await inventory.load();
  assert.equal(frozen.destinations.includes(destination(3)), results[1].status === "fulfilled");
  await assert.rejects(independent.freeze("f".repeat(32)), /another cancellation/);
} else {
  const recovered = await inventory.freeze(id);
  assert.equal(recovered.operation, id);
  for (const n of [0, 1, 2]) assert.ok(recovered.destinations.includes(destination(n)));
  await assert.rejects(inventory.register(destination(4)), /frozen/);
  await assert.rejects(inventory.initialize([]));
}
// Exercise composition of both real adapters. These are structural storage
// fixtures, not authenticated cancellation or assignment-completion evidence.
const fixtureSecret = new Uint8Array(32); fixtureSecret[31] = 1;
const fixtureKey = p256.getPublicKey(fixtureSecret, false);
const agent = Buffer.from(fixtureKey.slice(1, 33)).toString("base64url") + "." + Buffer.from(fixtureKey.slice(33)).toString("base64url");
const forum = `forum_${seaToPrincipalKey(agent)}_${"1".repeat(32)}`;
fixtureSecret[31] = 2;
const replacementKey = p256.getPublicKey(fixtureSecret, false);
const replacement = Buffer.from(replacementKey.slice(1, 33)).toString("base64url") + "." + Buffer.from(replacementKey.slice(33)).toString("base64url");
const boundScope = "f".repeat(64);
const boundInventory = createDelegationInventory(createBlobInventoryStore(container, boundScope));
const bound = createInventoryBoundOutbox(boundInventory,
  createCancellationOutbox(createBlobCancellationOutboxStore(container, boundScope)), { forum, agent });
const record = { owner: agent, object: forum, accessor: agent, stated: 0, from: 0, until: 10,
  issuedAt: 1, hamState: 2, sig: "unverified-storage-fixture" };
const parsed = parseForumAuthority("post", record); assert.ok(parsed);
const cancellations = [{ kind: "post" as const, soul: parsed.soul, recordJson: JSON.stringify(record) }];
if (phase === "write") {
  await boundInventory.initialize([forum]); await boundInventory.freeze(id);
  await bound.prepareReassignment(id, replacement, cancellations);
} else {
  assert.deepEqual((await bound.loadReassignment(id, replacement))?.cancellations, cancellations);
  assert.deepEqual((await bound.prepareReassignment(id, replacement, cancellations)).cancellations, cancellations);
  assert.equal((await bound.loadReassignment(id, replacement)).replacement, replacement);
  await assert.rejects(bound.prepare(id, cancellations), /conflict/);
  const wrong = createInventoryBoundOutbox(boundInventory,
    createCancellationOutbox(createBlobCancellationOutboxStore(container, boundScope)),
    { forum: forum.replace(/1{32}$/, "2".repeat(32)), agent });
  await assert.rejects(wrong.load(id), /binding mismatch/);
}
const replacementStore = createBlobReplacementGrantStore(container, boundScope);
const grantOutbox = createReplacementGrantOutbox({ inventory: boundInventory, outbox: bound, store: replacementStore });
const grantRecord = { ...record, stated: 1, accessor: replacement };
const grantParsed = parseForumAuthority("post", grantRecord); assert.ok(grantParsed);
const grants = [{ kind: "post" as const, soul: grantParsed.soul, recordJson: JSON.stringify(grantRecord) }];
if (phase === "write") {
  await grantOutbox.prepare(id, replacement, grants);
} else {
  assert.deepEqual((await grantOutbox.load(id, replacement))?.grants, grants);
  assert.deepEqual((await grantOutbox.prepare(id, replacement, grants)).grants, grants);
  const changed = [{ ...grants[0], recordJson: JSON.stringify({ ...grantRecord, until: 20 }) }];
  await assert.rejects(grantOutbox.prepare(id, replacement, changed), /conflict/);
  assert.deepEqual((await bound.loadReassignment(id, replacement)).cancellations, cancellations);
}
console.log(`cancellation Blob, inventory, bound recovery and replacement grants ${phase} passed`);

}
main().catch(error => { console.error(error); process.exitCode = 1; });
