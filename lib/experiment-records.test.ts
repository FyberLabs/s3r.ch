import test from "node:test";
import assert from "node:assert/strict";
import { createExperimentRecords } from "./experiment-records";
const config = { origin: "https://storage.example.test", tenant: "12345678-1234-4234-8234-123456789abc", cacheKey: "read-only-key-123456", outboxKey: "outbox-write-123456" };
const name = `s3rch-outbox-${"a".repeat(64)}`;
test("cache and outbox credentials stay separate with exact tenant and conditional writes", async () => {
  const calls: Array<[string, RequestInit]> = [];
  const store = createExperimentRecords(config, async (url, init) => {
    calls.push([String(url), init!]);
    return new Response(init?.method === "PUT" ? null : "{}", { status: init?.method === "PUT" ? 201 : 200, headers: { etag: `"${"b".repeat(64)}"` } });
  });
  await store.cache.get("cache", "experiments-v1-s3rch");
  assert.equal(await store.outbox.write(name, "{}", null), true);
  assert.equal((await store.outbox.read(name))?.revision, "b".repeat(64));
  for (const [i, [, request]] of calls.entries()) {
    const headers = new Headers(request.headers);
    assert.equal(headers.get("x-api-key"), i === 0 ? config.cacheKey : config.outboxKey);
    assert.equal(headers.get("x-tenant-id"), config.tenant);
    assert.equal(request.redirect, "error"); assert.equal(request.credentials, "omit");
    if (i === 1) assert.equal(headers.get("if-none-match"), "*");
  }
  await assert.rejects(() => store.cache.get("cache", "foreign"));
  await assert.rejects(() => store.outbox.read("other"));
});
test("only exact conflicts retry, and transport errors never leak credentials", async () => {
  assert.throws(() => createExperimentRecords({ ...config, outboxKey: config.cacheKey }));
  const conflict = createExperimentRecords(config, async () => new Response(null, { status: 412 }));
  assert.equal(await conflict.outbox.write(name, "{}", null), false);
  const denied = createExperimentRecords(config, async () => new Response(null, { status: 403 }));
  await assert.rejects(() => denied.outbox.write(name, "{}", null), /unavailable/);
  const failure = createExperimentRecords(config, async () => { throw Error(config.cacheKey); });
  await assert.rejects(() => failure.cache.get("cache", "experiments-v1-s3rch"), { message: "Experiment storage unavailable" });
});
