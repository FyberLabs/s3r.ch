import assert from "node:assert/strict";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { setTimeout as delay } from "node:timers/promises";
import { createBlobCancellationOutboxStore } from "../lib/delegation-blob-outbox";
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
console.log(`cancellation Blob integration ${phase} passed`);

}
main().catch(error => { console.error(error); process.exitCode = 1; });
