import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { gzipSync } from "node:zlib";
import { fetchPublicJson, fetchPublicText, PUBLIC_FEED_BYTES, PUBLIC_FEED_CONCURRENCY } from "./public-fetch";

const url = "https://example.org/feed";
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

it("accepts the exact byte boundary and preserves split UTF-8", async () => {
  const data = new TextEncoder().encode('"é"' + " ".repeat(PUBLIC_FEED_BYTES - 4));
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(data.subarray(0, 2));
      controller.enqueue(data.subarray(2));
      controller.close();
    },
  }));
  assert.equal(await fetchPublicJson(url), "é");
});

it("cancels chunked overflow even with a dishonest length, and unlocks the body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(PUBLIC_FEED_BYTES));
      controller.enqueue(Uint8Array.of(32));
    },
    cancel() { cancelled = true; },
  });
  globalThis.fetch = async () => new Response(body, { headers: { "content-length": "1" } });
  await assert.rejects(fetchPublicText(url), /larger than 1MB/);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

it("applies the limit after gzip decoding", async () => {
  const compressed = gzipSync(" ".repeat(PUBLIC_FEED_BYTES + 1));
  const decoded = new Blob([new Uint8Array(compressed)]).stream().pipeThrough(new DecompressionStream("gzip"));
  globalThis.fetch = async () => new Response(decoded, { headers: {
    "content-encoding": "gzip", "content-length": String(compressed.length),
  } });
  await assert.rejects(fetchPublicJson(url), /larger than 1MB/);
});

it("discards an unread HTTP error and releases malformed JSON after EOF", async () => {
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { status: 503 });
  await assert.rejects(fetchPublicJson(url), /HTTP 503/);
  assert.equal(cancelled, true);
  const malformed = new Response("{");
  globalThis.fetch = async () => malformed;
  await assert.rejects(fetchPublicJson(url), SyntaxError);
  assert.equal(malformed.bodyUsed, true);
  assert.equal(malformed.body?.locked, false);
});

it("bounds overlapping pulls before opening another connection and restores capacity", async () => {
  const gate = Promise.withResolvers<void>();
  let opened = 0;
  globalThis.fetch = async () => {
    opened++;
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        await gate.promise;
        controller.enqueue(Uint8Array.of(49));
        controller.close();
      },
    }));
  };
  const pulls = Array.from({ length: PUBLIC_FEED_CONCURRENCY }, () => fetchPublicJson(url));
  try {
    await assert.rejects(fetchPublicJson(url), /concurrent/);
  } finally {
    gate.resolve();
  }
  assert.deepEqual(await Promise.all(pulls), Array(pulls.length).fill(1));
  assert.equal(opened, PUBLIC_FEED_CONCURRENCY);
  globalThis.fetch = async () => new Response("2");
  assert.equal(await fetchPublicJson(url), 2);
});
