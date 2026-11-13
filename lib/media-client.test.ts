import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { createMediaHttpClient } from "./media-client";
import { seaToPrincipalKey } from "./identity/forum-check";
const point = p256.getPublicKey(new Uint8Array(32).fill(53), false);
const owner = Buffer.from(point.slice(1, 33)).toString("base64url") + "." + Buffer.from(point.slice(33)).toString("base64url");
const object = `media_${seaToPrincipalKey(owner)}_${"a".repeat(32)}`;
const bytes = new Uint8Array(40); bytes.set([0x73, 0x33, 0x6d, 1]);
const reference = { sha256: createHash("sha256").update(bytes).digest("hex"), length: bytes.length };
const row = { object, owner, issuedAt: 1, sig: "candidate" };
const headers = { "content-type": "application/octet-stream", "content-length": String(bytes.length), etag: `"${reference.sha256}"` };
const response = (body = bytes, fields: Record<string, string> = {}) => new Response(new Uint8Array(body), { headers: { ...headers, ...fields } });
test("registration and uploads send only bounded signed metadata or snapshotted ciphertext", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createMediaHttpClient(async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(null, { status: 201 }); });
  await client.register({ ...row, hiddenKey: "never send" } as typeof row);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), row);
  const copy = new Uint8Array(bytes), expected = { ...reference }, writing = client.put(object, copy, expected);
  copy.fill(9); expected.sha256 = "0".repeat(64); await writing;
  assert.deepEqual(calls[1].init.body, bytes);
  assert.deepEqual(Object.fromEntries(new Headers(calls[1].init.headers)), { "content-type": "application/octet-stream", "x-media-sha256": reference.sha256 });
  for (const call of calls) {
    assert.equal(call.url, `/api/media/${object}`); assert.equal(call.init.credentials, "same-origin");
    assert.equal(call.init.redirect, "error"); assert.equal(call.init.cache, "no-store");
  }
});
test("downloads validate the private reference and return only exact ciphertext", async () => {
  const client = createMediaHttpClient(async (_url, init) => {
    assert.equal(init?.method, "GET"); assert.equal(init?.credentials, "same-origin"); return response();
  });
  assert.deepEqual(await client.get(object, reference), bytes);
});
test("bad object, references and ciphertext never reach fetch", async () => {
  let calls = 0; const client = createMediaHttpClient(async () => { calls++; return response(); });
  await assert.rejects(client.get("https://evil.test", reference));
  await assert.rejects(client.register({ ...row, object: "bad" }));
  for (const expected of [{ ...reference, sha256: "bad" }, { ...reference, length: 0 }, { ...reference, length: 67108865 }]) {
    await assert.rejects(client.get(object, expected)); await assert.rejects(client.put(object, bytes, expected));
  }
  const changed = new Uint8Array(bytes); changed[10]++;
  await assert.rejects(client.put(object, changed, reference));
  await assert.rejects(client.put(object, bytes.slice(1), reference));
  assert.equal(calls, 0);
});
test("write refusals do not expose provider bodies or silently retry", async () => {
  let cancelled = 0, calls = 0;
  const client = createMediaHttpClient(async () => {
    calls++; return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 403 });
  });
  await assert.rejects(client.register(row), /Media write refused/);
  await assert.rejects(client.put(object, bytes, reference), /Media write refused/);
  assert.equal(calls, 2); assert.equal(cancelled, 2);
});
test("wrong metadata, partial content, truncated bytes and digest substitution are rejected", async () => {
  for (const fields of [{ "content-type": "text/html" }, { "content-length": "41" }, { etag: '"other"' }, { "content-encoding": "gzip" }] as Record<string, string>[])
    await assert.rejects(createMediaHttpClient(async () => response(bytes, fields)).get(object, reference));
  await assert.rejects(createMediaHttpClient(async () => new Response(bytes, { status: 206, headers })).get(object, reference));
  for (const wrong of [bytes.slice(1), new Uint8Array(41), new Uint8Array(40)])
    await assert.rejects(createMediaHttpClient(async () => response(wrong)).get(object, reference));
});
test("request cancellation cancels stalled download streams and pre-aborted calls do not fetch", async () => {
  let calls = 0, cancelled = 0; const controller = new AbortController();
  const client = createMediaHttpClient(async () => {
    calls++; return new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers });
  });
  const pending = client.get(object, reference, controller.signal);
  await Promise.resolve(); controller.abort(); await assert.rejects(pending);
  assert.equal(cancelled, 1);
  await assert.rejects(client.get(object, reference, controller.signal));
  await assert.rejects(client.put(object, bytes, reference, controller.signal));
  await assert.rejects(client.register(row, controller.signal));
  assert.equal(calls, 1);
});

test("registration cleanup sends only the signed record and requires empty-success status", async () => {
  const client = createMediaHttpClient(async (_url, init) => {
    assert.equal(init?.method, "DELETE"); assert.deepEqual(JSON.parse(String(init?.body)), row);
    return new Response(null, { status: 204 });
  });
  await client.removeRegistration(row);
  await assert.rejects(createMediaHttpClient(async () => new Response(null, { status: 201 })).removeRegistration(row));
  await assert.rejects(client.removeRegistration({ ...row, object: "bad" }));
});
