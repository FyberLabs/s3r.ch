import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { seaToPrincipalKey } from "./identity/forum-check";
import { createHttpForumAuthorityReader } from "./forum-authority-http";
const key = p256.getPublicKey(new Uint8Array(32).fill(53), false);
const owner = Buffer.from(key.slice(1, 33)).toString("base64url") + "." + Buffer.from(key.slice(33)).toString("base64url");
const squad = { owner, forumId: `forum_${seaToPrincipalKey(owner)}_${"a".repeat(32)}`, label: "Test" };
const snapshot = { completeThrough: 100, history: { completeThrough: 100, accounts: [], links: [] }, rows: [] };
const envelope = { version: 1, forumId: squad.forumId, owner, evaluatedAt: 100, snapshot };
const response = (value: unknown) => Response.json(value);
const readWith = (fetcher: typeof fetch) => createHttpForumAuthorityReader({ endpoint: "/api/squad/authority", squad, fetch: fetcher });

test("authority request binds scope/time and requires same-origin session transport", async () => {
  const controller = new AbortController();
  const read = readWith(async (url, init) => {
    assert.equal(url, "/api/squad/authority");
    assert.equal(init?.mode, "same-origin"); assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
    assert.equal(init?.signal, controller.signal); assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(init!.body as string), { version: 1, forumId: squad.forumId, owner, evaluatedAt: 100 });
    return response(envelope);
  });
  assert.deepEqual(await read(100, controller.signal), snapshot);
  for (const endpoint of ["https://evil.example/a", "//evil.example/a", "/\\evil", "/api/x?redirect=x", "/api/%2f%2fevil", "/api/../x"]) {
    assert.throws(() => createHttpForumAuthorityReader({ endpoint, squad }));
  }
});

test("cross-scope, stale and malformed authority envelopes fail closed", async () => {
  const bad = [null, {}, { ...envelope, version: 2 }, { ...envelope, owner: "other" }, { ...envelope, forumId: "other" },
    { ...envelope, evaluatedAt: 99 }, { ...envelope, extra: true },
    { ...envelope, snapshot: { ...snapshot, completeThrough: 99 } },
    { ...envelope, snapshot: { ...snapshot, history: { ...snapshot.history, completeThrough: 99 } } },
    { ...envelope, snapshot: { ...snapshot, rows: Array(1025).fill({}) } }];
  for (const value of bad) assert.equal(await readWith(async () => response(value))(100, new AbortController().signal), null);
  for (const value of [new Response("login", { headers: { "content-type": "text/html" } }),
    new Response("{}", { status: 403 }), new Response("{bad", { headers: { "content-type": "application/json" } })])
    assert.equal(await readWith(async () => value)(100, new AbortController().signal), null);
});

test("stream size limit cancels bodies without trusting Content-Length", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
  const value = new Response(stream, { headers: { "content-type": "application/json", "content-length": "1" } });
  assert.equal(await readWith(async () => value)(100, new AbortController().signal), null);
  assert.equal(cancelled, true);
});

test("abort cancels a stalled body and cannot return authority", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const promise = readWith(async () => new Response(stream, { headers: { "content-type": "application/json" } }))(100, controller.signal);
  await Promise.resolve(); controller.abort();
  await assert.rejects(promise); assert.equal(cancelled, true);
});
