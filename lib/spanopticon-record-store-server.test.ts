import test from "node:test";
import assert from "node:assert/strict";
import { createSpanopticonRecordStore } from "./spanopticon-record-store-server";
import { RECORD_BYTES_MAX, RecordConflict, type RecordNamespace } from "./record-store";
const config = { origin: "https://storage.example", tenant: "11111111-1111-4111-8111-111111111111", apiKey: "private.key" };
const revision = "a".repeat(64), etag = `"${revision}"`, bytes = new Uint8Array([0, 255]);
const client = (f: (url: string, init: RequestInit) => Promise<Response>) => createSpanopticonRecordStore(config, ((url: string, init: RequestInit) => url.endsWith("/access") ? Promise.resolve(new Response(null, { status: 404 })) : f(url, init)) as typeof fetch);

test("records bind authority and preserve binary bytes, conditions and revisions", async () => {
  const calls: RequestInit[] = [];
  const store = client(async (url, init) => {
    assert.equal(url, config.origin + "/api/v1/storage/records/cache/feed");
    assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit"); assert.equal(init.cache, "no-store");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-api-key"), config.apiKey); assert.equal(headers.get("x-tenant-id"), config.tenant);
    calls.push(init);
    if (init.method === "GET") return new Response(bytes, { headers: { etag, "content-length": "2" } });
    if (init.method === "DELETE") { assert.equal(headers.get("if-match"), etag); return new Response(null, { status: 204 }); }
    assert.deepEqual(init.body, bytes);
    const create = headers.get("if-none-match") === "*";
    assert.equal(headers.get("if-match"), create ? null : etag);
    return new Response(null, { status: create ? 201 : 204, headers: { etag } });
  });
  assert.equal(await store.put("cache", "feed", bytes, null), revision);
  assert.equal(await store.put("cache", "feed", bytes, revision), revision);
  assert.deepEqual(await store.get("cache", "feed"), { bytes, revision });
  await store.delete("cache", "feed", revision);
  assert.equal(calls.length, 4);
});

test("conflicts are typed and never retried; missing reads are distinct", async () => {
  assert.equal(await client(async () => new Response(null, { status: 404 })).get("cache", "feed"), null);
  let calls = 0;
  const store = client(async () => { calls++; return new Response("private", { status: 412 }); });
  await assert.rejects(store.put("cache", "feed", bytes, null), RecordConflict);
  await assert.rejects(store.put("cache", "feed", bytes, revision), RecordConflict);
  await assert.rejects(store.delete("cache", "feed", revision), RecordConflict);
  assert.equal(calls, 3);
  await assert.rejects(store.get("cache", "feed"), { message: "Tenant record storage unavailable" });
});

test("read bounds, malformed responses and provider details fail closed", async () => {
  const invalidHeaders: Record<string, string>[] = [{}, { etag: 'W/'+etag }, { etag, "content-encoding": "gzip" },
    ...["bad", "0", "1", "3", String(RECORD_BYTES_MAX+1)].map(length => ({ etag, "content-length": length }))];
  for (const headers of invalidHeaders) {
    await assert.rejects(client(async () => new Response(bytes, { headers })).get("cache", "feed"), { message: "Tenant record storage unavailable" });
  }
  for (const status of [301, 401, 403, 500, 206]) await assert.rejects(client(async () => new Response("private", { status })).get("cache", "feed"));
  for (const data of [null, new Uint8Array()]) await assert.rejects(client(async () => new Response(data, { headers: { etag } })).get("cache", "feed"));
  assert.deepEqual(await client(async () => new Response(bytes, { headers: { etag } })).get("cache", "feed"), { bytes, revision });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(RECORD_BYTES_MAX+1)); }, cancel() { cancelled = true; } });
  await assert.rejects(client(async () => new Response(body, { headers: { etag } })).get("cache", "feed"));
  assert.equal(cancelled, true);
  await assert.rejects(client(async () => { throw new Error(config.apiKey); }).get("cache", "feed"), { message: "Tenant record storage unavailable" });
});

test("invalid arguments and aborted calls never reach provider", async () => {
  let calls = 0; const store = client(async () => { calls++; throw new Error(); });
  for (const name of ["../feed", "", "x".repeat(129), "feed?token"]) {
    await assert.rejects(store.get("cache", name)); await assert.rejects(store.put("cache", name, bytes, null)); await assert.rejects(store.delete("cache", name, revision));
  }
  await assert.rejects(store.get("objects" as RecordNamespace, "feed"));
  for (const tag of ["", '"'+revision+'"', "A".repeat(64)]) {
    await assert.rejects(store.put("cache", "feed", bytes, tag)); await assert.rejects(store.delete("cache", "feed", tag));
  }
  for (const body of [new Uint8Array(), new Uint8Array(RECORD_BYTES_MAX+1)]) await assert.rejects(store.put("cache", "feed", body, null));
  await assert.rejects(store.get("cache", "feed", AbortSignal.abort()));
  assert.equal(calls, 0);
});

test("write responses require exact status and revision", async () => {
  for (const response of [new Response(null, {status:201}), new Response(null, {status:200,headers:{etag}}), new Response(null, {status:204,headers:{etag}})]) {
    await assert.rejects(client(async () => response).put("cache", "feed", bytes, null));
  }
  await assert.rejects(client(async () => new Response(null, {status:201,headers:{etag}})).put("cache", "feed", bytes, revision));
  await assert.rejects(client(async () => new Response(null, {status:404})).delete("cache", "feed", revision));
});

test("configuration is server-owned and uploads snapshot mutable inputs", async () => {
  for (const origin of ["bad", "http://storage.example", "https://u:p@storage.example", "https://storage.example/path", "https://storage.example?q=x", "https://storage.example#x", "https://storage.example:8443"]) assert.throws(() => createSpanopticonRecordStore({...config,origin}));
  for (const tenant of ["bad","00000000-0000-0000-0000-000000000000"]) assert.throws(() => createSpanopticonRecordStore({...config,tenant}));
  for (const apiKey of ["", "secret\nheader", " ", "x".repeat(4097)]) assert.throws(() => createSpanopticonRecordStore({...config,apiKey}));
  const mutable = {...config}, input = bytes.slice(); let finish!: () => void;
  const ready = new Promise<void>(resolve => {finish=resolve;});
  const store = createSpanopticonRecordStore(mutable, (async (_url,init) => {
    await ready; assert.deepEqual(init?.body,bytes); assert.equal(new Headers(init?.headers).get("x-api-key"),config.apiKey);
    return new Response(null,{status:201,headers:{etag}});
  }) as typeof fetch);
  const upload = store.put("fixtures","feed",input,null); input.fill(0); mutable.apiKey="changed"; finish(); await upload;
});
