import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import type { ContainerClient } from "@azure/storage-blob";
import { createBlobInventoryStore } from "./delegation-blob-inventory";
const setup = (client: object) => createBlobInventoryStore({ getBlockBlobClient() { return client; } } as unknown as ContainerClient, "b".repeat(64));
test("inventory writes require the exact ETag and never use unconditional replacement", async () => {
  const conditions: unknown[] = [];
  const store = setup({ async upload(_body: Buffer, _size: number, options: { conditions: unknown }) { conditions.push(options.conditions); return { etag: "new" }; } });
  assert.ok(await store.compareAndSwap(null, "{}"));
  assert.ok(await store.compareAndSwap('"old"', "{}"));
  assert.deepEqual(conditions, [{ ifNoneMatch: "*" }, { ifMatch: '"old"' }]);
  await assert.rejects(store.compareAndSwap("*", "{}"));
  await assert.rejects(store.compareAndSwap("", "{}"));
  assert.equal(conditions.length, 2);
});
test("transport and authorization failures do not turn into retryable CAS conflicts", async () => {
  for (const [statusCode, code] of [[412, "ConditionNotMet"], [412, "LeaseIdMissing"], [403, "AuthorizationFailure"], [409, "BlobAlreadyExists"]] as const) {
    const error = Object.assign(Error(code), { statusCode, code });
    const store = setup({ async upload() { throw error; } });
    if (code === "ConditionNotMet") assert.equal(await store.compareAndSwap("etag", "{}"), false);
    else await assert.rejects(store.compareAndSwap("etag", "{}"), e => e === error);
  }
});
test("inventory read returns the body and ETag from one bounded snapshot", async () => {
  const stream = Readable.from([Buffer.from("{}")]);
  const store = setup({ async download(offset: number, count: number) {
    assert.equal(offset, 0); assert.equal(count, 131073);
    return { etag: '"snapshot"', contentLength: 2, readableStreamBody: stream };
  } });
  assert.deepEqual(await store.read(), { text: "{}", etag: '"snapshot"' });
  assert.ok(stream.destroyed);
});
test("corrupt read and missing container cannot become an absent registry", async () => {
  const stream = Readable.from([Buffer.from("{}")]);
  await assert.rejects(setup({ async download() { return { etag: "e", contentLength: 5, readableStreamBody: stream }; } }).read(), /truncated/);
  assert.ok(stream.destroyed);
  const missingContainer = Object.assign(Error("container"), { statusCode: 404, code: "ContainerNotFound" });
  await assert.rejects(setup({ async download() { throw missingContainer; } }).read(), e => e === missingContainer);
});
