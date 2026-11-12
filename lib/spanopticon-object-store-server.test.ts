import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { OBJECT_BYTES_MAX } from "./object-store";
import { createSpanopticonObjectStore } from "./spanopticon-object-store-server";
const config = { origin: "https://storage.example", tenant: "afee9b29-1706-5590-bbbf-e58df8945ac0", apiKey: "private.fixture.key" };
const bytes = new Uint8Array([0, 255, 128, 9]);
const id = createHash("sha256").update(bytes).digest("hex");
const etag = `"${id}"`;
const client = (f: (url: string, init: RequestInit) => Promise<Response>) => createSpanopticonObjectStore(config, f as typeof fetch);

test("tenant client binds service authority and preserves immutable binary bytes", async () => {
  const calls: RequestInit[] = [];
  const store = client(async (url, init) => {
    assert.equal(url, `${config.origin}/api/v1/storage/objects/${id}`);
    assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store"); assert.equal(init.credentials, "omit");
    assert.equal(new Headers(init.headers).get("X-Api-Key"), config.apiKey);
    assert.equal(new Headers(init.headers).get("X-Tenant-ID"), config.tenant);
    calls.push(init);
    if (init.method === "GET") return new Response(bytes, { headers: { etag } });
    if (init.method === "PUT") { assert.deepEqual(init.body, bytes); return new Response(null, { status: calls.length === 1 ? 201 : 204, headers: { etag } }); }
    return new Response(null, { status: 204 });
  });
  await store.put(id, bytes); await store.put(id, bytes);
  assert.deepEqual(await store.get(id), bytes);
  await store.delete(id);
  assert.equal(calls.length, 4);
});

test("missing object is distinct from denied, unavailable, redirected and partial reads", async () => {
  assert.equal(await client(async () => new Response(null, { status: 404 })).get(id), null);
  for (const status of [301, 401, 403, 500, 206]) {
    await assert.rejects(client(async () => new Response("private provider detail", { status })).get(id), { message: "Tenant object storage unavailable" });
  }
});

test("checks returned address, bounded declared size, actual size and checksum", async () => {
  const cases: Record<string, string>[] = [{}, { etag: '"wrong"' }, { etag, "content-encoding": "gzip" }, { etag, "content-length": "5" }, { etag, "content-length": "3" }, { etag, "content-length": "bad" }, { etag, "content-length": "0" }, { etag, "content-length": String(OBJECT_BYTES_MAX + 1) }];
  for (const headers of cases) {
    await assert.rejects(client(async () => new Response(bytes, { headers })).get(id));
  }
  assert.deepEqual(await client(async () => new Response(bytes, { headers: { etag, "content-length": "4" } })).get(id), bytes);
  await assert.rejects(client(async () => new Response(new Uint8Array([1,2,3,4]), { headers: { etag } })).get(id));
  await assert.rejects(client(async () => new Response(null, { headers: { etag } })).get(id));
  await assert.rejects(client(async () => new Response(new Uint8Array(), { headers: { etag } })).get(id));
});

test("oversized chunked downloads are cancelled before returning bytes", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(OBJECT_BYTES_MAX + 1)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(client(async () => new Response(stream, { headers: { etag } })).get(id));
  assert.equal(cancelled, true);
});

test("invalid input never calls the provider", async () => {
  let calls = 0;
  const store = client(async () => { calls++; throw new Error(); });
  for (const address of ["../secret", "a".repeat(63), id.toUpperCase()]) {
    await assert.rejects(store.get(address)); await assert.rejects(store.delete(address)); await assert.rejects(store.put(address, bytes));
  }
  for (const payload of [new Uint8Array(), new Uint8Array([1]), new Uint8Array(OBJECT_BYTES_MAX + 1)]) await assert.rejects(store.put(id, payload));
  const aborted = AbortSignal.abort();
  await assert.rejects(store.get(id, aborted));
  assert.equal(calls, 0);
});

test("upload snapshots bytes and configuration before asynchronous work", async () => {
  const mutable = { ...config }, input = bytes.slice();
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  const store = createSpanopticonObjectStore(mutable, (async (_url, init) => {
    await ready;
    assert.deepEqual(init?.body, bytes);
    assert.equal(new Headers(init?.headers).get("X-Api-Key"), config.apiKey);
    return new Response(null, { status: 201, headers: { etag } });
  }) as typeof fetch);
  const upload = store.put(id, input);
  input.fill(0); mutable.apiKey = "changed"; finish(); await upload;
});

test("provider exceptions and invalid write responses never expose credentials", async () => {
  await assert.rejects(client(async () => { throw new Error(config.apiKey); }).get(id), { message: "Tenant object storage unavailable" });
  for (const response of [new Response(null, { status: 201 }), new Response(null, { status: 200, headers: { etag } })]) await assert.rejects(client(async () => response).put(id, bytes));
  await assert.rejects(client(async () => new Response(null, { status: 403 })).delete(id));
});

test("configuration refuses URL credentials, alternate paths and malformed tenant keys", () => {
  for (const origin of ["http://storage.example", "https://user:pass@storage.example", "https://storage.example/path", "https://storage.example?q=secret", "https://storage.example#secret", "https://storage.example:8443", "bad"]) assert.throws(() => createSpanopticonObjectStore({ ...config, origin }));
  for (const tenant of ["bad", "00000000-0000-0000-0000-000000000000"]) assert.throws(() => createSpanopticonObjectStore({ ...config, tenant }));
  for (const apiKey of ["", "secret\nheader", " ", "a".repeat(4097)]) assert.throws(() => createSpanopticonObjectStore({ ...config, apiKey }));
});
