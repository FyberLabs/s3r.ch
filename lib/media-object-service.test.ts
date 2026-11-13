import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createMediaObjectService } from "./media-object-service";
import { RecordConflict, type StoredRecord, type RecordStore } from "./record-store";
import { p256 } from "@noble/curves/nist.js";
const key = Buffer.from(p256.getPublicKey(new Uint8Array(32).fill(53), false).slice(1)).toString("hex");
const object = `media_p_${key}_${"a".repeat(32)}`;
const other = `media_p_${key}_${"b".repeat(32)}`;
const bytes = new Uint8Array(40); bytes.set([0x73, 0x33, 0x6d, 1]);
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const digest = hash(bytes);
function request(method = "GET", data = bytes, extra: Record<string, string> = {}) {
  return new Request("https://s3r.ch/api/media/" + object, { method, headers: { origin: "https://s3r.ch",
    ...(method === "PUT" ? { "content-type": "application/octet-stream", "content-length": String(data.length), "x-media-sha256": hash(data) } : {}), ...extra },
    ...(method === "PUT" ? { body: new Uint8Array(data) } : {}) });
}
function setup() {
  let record: StoredRecord | null = null, revision = 0, allowed = true, authorizations = 0, conflicts = 0;
  const data = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const hooks = { authorize: () => allowed, get: () => {}, put: () => {} };
  const records: RecordStore = {
    async get(namespace, name) { assert.equal(namespace, "media"); assert.equal(name, "object-index-v1"); calls.push("record-get"); return record && structuredClone(record); },
    async put(namespace, name, bytes, expected) {
      assert.equal(namespace, "media"); assert.equal(name, "object-index-v1"); calls.push("record-put");
      if (conflicts-- > 0 || expected !== (record?.revision ?? null)) throw new RecordConflict();
      record = { bytes: new Uint8Array(bytes), revision: String(++revision).padStart(64, "0") }; return record.revision;
    }, async delete() { throw Error("No deletion"); },
  };
  const service = createMediaObjectService({ origin: "https://s3r.ch", records,
    objects: { async get(id) { calls.push("object-get"); hooks.get(); return data.get(id) ?? null; },
      async put(id, bytes) { calls.push("object-put"); hooks.put(); data.set(id, new Uint8Array(bytes)); }, async delete() { throw Error("No deletion"); } },
    authorize: async () => { authorizations++; return hooks.authorize(); } });
  return { service, data, hooks, calls, deny: () => { allowed = false; }, authorizations: () => authorizations,
    record: () => record, setRecord: (value: unknown) => { record = { bytes: new TextEncoder().encode(JSON.stringify(value)), revision: "a".repeat(64) }; },
    conflicts: (n: number) => { conflicts = n; } };
}
test("owner uploads ciphertext after quota reservation; reads return only the bound digest", async () => {
  const h = setup(); assert.equal((await h.service(request("PUT"), object)).status, 201);
  assert.ok(h.calls.indexOf("record-put") < h.calls.indexOf("object-put"));
  const read = await h.service(request(), object);
  assert.equal(read.status, 200); assert.equal(read.headers.get("etag"), `"${digest}"`);
  assert.equal(read.headers.get("content-type"), "application/octet-stream");
  assert.equal(read.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), bytes);
  assert.equal((await h.service(request(), other)).status, 404);
  assert.equal((await h.service(request("PUT"), object)).status, 201);
  const changed = new Uint8Array(bytes); changed[10] = 2;
  assert.equal((await h.service(request("PUT", changed), object)).status, 409);
  const sameOrigin = request(); sameOrigin.headers.delete("origin"); sameOrigin.headers.set("sec-fetch-site", "same-origin");
  assert.equal((await h.service(sameOrigin, object)).status, 200);
});
test("authentication and origin denial precede storage; unsupported and malformed objects deny", async () => {
  const h = setup(); h.deny();
  assert.equal((await h.service(request(), object)).status, 403); assert.deepEqual(h.calls, []);
  assert.equal((await setup().service(request("GET", bytes, { origin: "https://evil.test" }), object)).status, 403);
  assert.equal((await setup().service(request("DELETE"), object)).status, 405);
  assert.equal((await setup().service(request(), "bad")).status, 400);
  const absent = request(); absent.headers.delete("origin");
  assert.equal((await setup().service(absent, object)).status, 403);
});
test("revocation during storage prevents ciphertext release and upload success", async () => {
  const h = setup(); await h.service(request("PUT"), object); h.hooks.get = h.deny;
  assert.equal((await h.service(request(), object)).status, 403);
  const upload = setup(); upload.hooks.put = upload.deny;
  assert.equal((await upload.service(request("PUT"), object)).status, 403);
  const before = setup(); before.hooks.authorize = () => before.authorizations() < 2;
  assert.equal((await before.service(request("PUT"), object)).status, 403);
  assert.equal(before.calls.includes("object-put"), false);
});
test("bounded reservation retries preserve quota and immutable object mapping", async () => {
  const h = setup(); h.conflicts(1); assert.equal((await h.service(request("PUT"), object)).status, 201);
  const lost = setup(); lost.conflicts(3); assert.equal((await lost.service(request("PUT"), object)).status, 409);
  assert.equal(lost.calls.includes("object-put"), false);
  const full = setup(); full.setRecord({ version: 1, entries: Array.from({ length: 128 }, (_, i) => ({
    object: `media_p_${key}_${i.toString(16).padStart(32, "0")}`, digest, length: 40 })) });
  assert.equal((await full.service(request("PUT"), object)).status, 507);
  const large = setup(); large.setRecord({ version: 1, entries: Array.from({ length: 4 }, (_, i) => ({
    object: `media_p_${key}_${i.toString(16).padStart(32, "0")}`, digest, length: 64 * 1024 * 1024 })) });
  assert.equal((await large.service(request("PUT"), object)).status, 507);
});
test("bad envelope, digest, size and content encoding are refused before reservation", async () => {
  for (const [headers, status] of [[{ "content-length": "0" }, 413], [{ "content-length": "67108865" }, 413],
    [{ "content-length": "41" }, 400], [{ "content-length": "39" }, 413], [{ "x-media-sha256": "a".repeat(64) }, 400],
    [{ "content-type": "image/png" }, 415], [{ "content-encoding": "gzip" }, 415]] as [Record<string,string>, number][]) {
    const h = setup(); assert.equal((await h.service(request("PUT", bytes, headers), object)).status, status);
    assert.equal(h.calls.includes("record-put"), false);
  }
  const bad = new Uint8Array(bytes); bad[0] = 0;
  assert.equal((await setup().service(request("PUT", bad), object)).status, 400);
});
test("corrupt private index and provider bytes fail closed without revealing details", async () => {
  for (const value of [{ version: 2, entries: [] }, { version: 1, entries: [{ object, digest, length: -1 }] },
    { version: 1, entries: [{ object, digest, length: 40 }, { object, digest, length: 40 }] }]) {
    const h = setup(); h.setRecord(value); assert.equal((await h.service(request(), object)).status, 503);
  }
  const h = setup(); await h.service(request("PUT"), object); h.data.set(digest, new Uint8Array(40));
  const response = await h.service(request(), object); assert.equal(response.status, 503); assert.equal(await response.text(), "");
  h.data.clear(); assert.equal((await h.service(request(), object)).status, 404);
});
test("abort cancels a stalled body and releases admission capacity", async () => {
  const h = setup(), controller = new AbortController(); let cancelled = false;
  const req = new Request(request("PUT"), { body: new ReadableStream({ cancel() { cancelled = true; } }),
    signal: controller.signal, duplex: "half" } as RequestInit);
  const pending = h.service(req, object); await new Promise(resolve => setImmediate(resolve)); controller.abort();
  assert.equal((await pending).status, 503); assert.equal(cancelled, true);
  assert.equal((await h.service(request("PUT"), object)).status, 201);
});

test("at most two media requests hold buffers per configured service", async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  // Hold authorization to exercise the shared admission bound.
  const source = createMediaObjectService({ origin: "https://s3r.ch", authorize: async () => { await hold; return false; },
    records: {} as RecordStore, objects: {} as import("./object-store").ObjectStore });
  const first = source(request(), object), second = source(request(), object);
  assert.equal((await source(request(), object)).status, 429);
  release(); assert.equal((await first).status, 403); assert.equal((await second).status, 403);
  assert.equal((await source(request(), object)).status, 403);
});

test("one owner cannot exhaust the tenant object or byte quota", async () => {
  const h = setup();
  const entries = Array.from({ length: 8 }, (_, i) => ({ object: `media_p_${key}_${i.toString(16).padStart(32, "0")}`, digest, length: bytes.length }));
  h.setRecord({ version: 1, entries });
  assert.equal((await h.service(request("PUT"), object)).status, 507);
  const otherKey = Buffer.from(p256.getPublicKey(new Uint8Array(32).fill(54), false).slice(1)).toString("hex");
  assert.equal((await h.service(request("PUT"), `media_p_${otherKey}_${"b".repeat(32)}`)).status, 201);
  const full = setup(); full.setRecord({ version: 1, entries: [{ ...entries[0], length: 64 * 1024 * 1024 }] });
  assert.equal((await full.service(request("PUT"), object)).status, 507);
  assert.equal(full.calls.includes("object-put"), false);
});
