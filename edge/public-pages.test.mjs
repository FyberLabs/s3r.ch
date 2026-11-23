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

test("the TEST service binding receives dynamic and missing-asset requests with original credentials", async () => {
  globalThis.fetch = () => assert.fail("unexpected direct origin request");
  for (const request of [
    new Request("https://test.s3r.ch/api/identity/session", { headers: { Cookie: "session=test" } }),
    new Request("https://test.s3r.ch/submit", { method: "POST", body: "record" }),
    new Request("https://test.s3r.ch/uncached"),
  ]) {
    const origin = new Response("bound origin");
    const env = {
      ASSETS: { fetch: () => new Response(null, { status: 404 }) },
      WEB_ORIGIN: { fetch(received) { assert.equal(received, request); return origin; } },
    };
    assert.equal(await worker.fetch(request, env), origin);
  }
});

test("production fallback stays on its existing public origin", async () => {
  const request = new Request("https://s3r.ch/api/version");
  const origin = new Response("production");
  globalThis.fetch = received => {
    assert.equal(received, request);
    return origin;
  };
  const env = { WEB_ORIGIN: { fetch() { assert.fail("TEST binding used from production"); } } };
  assert.equal(await worker.fetch(request, env), origin);
});
