import test from "node:test";
import assert from "node:assert/strict";
import { feedCacheSettings } from "./tenant-feed-cache-server";

test("remote configuration is complete, dedicated and never silently falls back", () => {
  const values = { S3RCH_FEED_STORAGE_ORIGIN: "https://storage.example", S3RCH_FEED_STORAGE_TENANT_ID: "tenant", S3RCH_FEED_STORAGE_API_KEY: "key" };
  assert.equal(feedCacheSettings({}), null);
  assert.equal(feedCacheSettings({S3RCH_FEED_STORAGE_BACKEND:"filesystem"}), null);
  assert.deepEqual(feedCacheSettings(values), {origin:values.S3RCH_FEED_STORAGE_ORIGIN,tenant:"tenant",apiKey:"key"});
  assert.deepEqual(feedCacheSettings({...values,S3RCH_FEED_STORAGE_BACKEND:"spanopticon"}), feedCacheSettings(values));
  for (const backend of ["filesystem","unknown",""]) assert.throws(()=>feedCacheSettings({...values,S3RCH_FEED_STORAGE_BACKEND:backend}));
  assert.throws(()=>feedCacheSettings({S3RCH_FEED_STORAGE_BACKEND:"spanopticon"}));
  for (const name of Object.keys(values)) {const incomplete:Record<string, string | undefined>={...values};delete incomplete[name];assert.throws(()=>feedCacheSettings(incomplete));}
});
