import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import worker from "./public-pages.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("documents use the asset binding; an absent asset falls through to origin", async () => {
  const request = new Request("https://test.s3r.ch/feed");
  const document = new Response("public HTML");
  const origin = new Response("origin");
  let originCalls = 0;
  globalThis.fetch = received => {
    assert.equal(received, request);
    originCalls++;
    return origin;
  };
  for (const asset of [document, new Response(null, { status: 404 })]) {
    const env = { ASSETS: { fetch(received) { assert.equal(received, request); return asset; } } };
    const response = await worker.fetch(request, env);
    assert.equal(response, asset === document ? document : origin);
  }
  assert.equal(originCalls, 1);
});

test("origin receives the original method, credentials, query and router headers", async () => {
  const env = { ASSETS: { fetch() { assert.fail("unexpected static asset lookup"); } } };
  for (const [path, init] of [
    ["/api/identity/session", { headers: { Cookie: "session=test" } }],
    ["/api/forum", { method: "POST", body: "test" }],
    ["/api/seed", { method: "POST", headers: { Authorization: "Bearer test" } }],
    ["/feed-cache/snapshot.json", {}], ["/gun", { headers: { Upgrade: "websocket" } }],
    ["/features?_rsc=abc", {}], ["/views/example", { headers: { RSC: "1" } }],
    ["/feed", { headers: { "Next-Router-State-Tree": "test" } }],
    ["/features", { headers: { Accept: "text/x-component" } }],
  ]) {
    const request = new Request("https://test.s3r.ch" + path, init);
    const result = new Response(null, { status: 401 });
    globalThis.fetch = received => { assert.equal(received, request); return result; };
    assert.equal(await worker.fetch(request, env), result);
  }
});
