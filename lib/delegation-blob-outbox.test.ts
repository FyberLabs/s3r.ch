import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import type { ContainerClient } from "@azure/storage-blob";
import { createBlobCancellationOutboxStore, createBlobReplacementGrantStore, CANCELLATION_BLOB_MAX_BYTES as cap } from "./delegation-blob-outbox";
const id = "a".repeat(32), scope = "b".repeat(64);
function setup(client: object) {
  const names: string[] = [];
  const container = { getBlockBlobClient(name: string) { names.push(name); return client; } } as unknown as ContainerClient;
  return { store: createBlobCancellationOutboxStore(container, scope), names };
}
const failure = (statusCode: number, code: string) => Object.assign(Error(code), { statusCode, code });
test("conditional creation preserves exact UTF-8 bytes in an isolated namespace", async () => {
  let calls = 0;
  const { store, names } = setup({ async upload(body: Buffer, length: number, options: any) {
    calls++; assert.equal(body.toString(), "é"); assert.equal(length, 2);
    assert.deepEqual(options.conditions, { ifNoneMatch: "*" }); assert.ok(options.abortSignal);
    return { etag: "etag" };
  } });
  await store.create(id, "é");
  assert.equal(calls, 1); assert.equal(names[0], `s3rch-delegation-outbox/v1/${scope}/${id}.json`);
  await assert.rejects(store.create("../escape", "x"));
  await assert.rejects(store.create(id, "x".repeat(cap + 1)));
  assert.equal(calls, 1);
});
test("only exact conditional conflict is treated as an existing operation", async () => {
  for (const error of [failure(412, "ConditionNotMet"), failure(409, "BlobAlreadyExists"), failure(412, "LeaseIdMissing"), failure(403, "AuthorizationFailure"), failure(404, "ContainerNotFound"), Error("response lost")]) {
    const { store } = setup({ async upload() { throw error; } });
    if (["ConditionNotMet", "BlobAlreadyExists"].includes((error as any).code)) await store.create(id, "{}");
    else await assert.rejects(store.create(id, "{}"), e => e === error);
  }
  await assert.rejects(setup({ async upload() { return {}; } }).store.create(id, "{}"), /ETag/);
});
test("only missing blob is absence; a missing container or denied read fails", async () => {
  for (const code of ["BlobNotFound", "ContainerNotFound", "AuthorizationFailure"]) {
    const error = failure(code === "AuthorizationFailure" ? 403 : 404, code);
    const { store } = setup({ async download() { throw error; } });
    if (code === "BlobNotFound") assert.equal(await store.read(id), null);
    else await assert.rejects(store.read(id), e => e === error);
  }
});
test("bounded reads reject oversized, truncated, invalid UTF-8 and incomplete responses", async () => {
  for (const [body, length, etag] of [[Buffer.from("é"), 2, "tag"], [Buffer.from("{}"), 4, "tag"], [Buffer.from([255]), 1, "tag"], [Buffer.from("{}"), cap + 1, "tag"], [Buffer.from("{}"), 2, undefined]] as const) {
    const stream = Readable.from([body]);
    const { store } = setup({ async download(offset: number, count: number) {
      assert.equal(offset, 0); assert.equal(count, cap + 1);
      return { etag, contentLength: length, readableStreamBody: stream };
    } });
    if (body.toString() === "é") assert.equal(await store.read(id), "é");
    else await assert.rejects(store.read(id));
    assert.equal(stream.destroyed, true);
  }
});

test("replacement grant documents cannot overwrite cancellation slots for the same operation", async () => {
  const documents = new Map<string, Buffer>();
  const container = { getBlockBlobClient(name: string) { return {
    async upload(body: Buffer, _length: number, options: any) {
      assert.deepEqual(options.conditions, { ifNoneMatch: "*" });
      if (documents.has(name)) throw failure(412, "ConditionNotMet");
      documents.set(name, body); return { etag: "tag" };
    },
    async download() {
      const body = documents.get(name)!;
      return { etag: "tag", contentLength: body.length, readableStreamBody: Readable.from([body]) };
    },
  }; } } as unknown as ContainerClient;
  const cancellation = createBlobCancellationOutboxStore(container, scope);
  const replacement = createBlobReplacementGrantStore(container, scope);
  await cancellation.create(id, "cancellation"); await replacement.create(id, "grants");
  await replacement.create(id, "changed");
  assert.equal(await cancellation.read(id), "cancellation");
  assert.equal(await replacement.read(id), "grants");
  assert.equal(documents.size, 2);
  assert.ok(documents.has(`s3rch-delegation-replacement-grants/v1/${scope}/${id}.json`));
});
