import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { pullPublicBluesky } from "./direct-bluesky";
import { seedUrlsForClass } from "./pull-relay";
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

it("reads only documented AppView endpoints without credentials or redirects", async () => {
  const urls: string[] = [];
  globalThis.fetch = async (url, options) => {
    urls.push(String(url));
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.redirect, "error");
    return Response.json({ feed: [] });
  };
  assert.deepEqual((await pullPublicBluesky())?.items, []);
  assert.deepEqual(urls, seedUrlsForClass("atproto"));
});

it("allows the existing ingest fallback when CORS denies the read", async () => {
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  assert.equal(await pullPublicBluesky(), null);
});
