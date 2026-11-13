import assert from "node:assert/strict";
import test from "node:test";
import { createAclStatementSource, configuredAclStatementSource, StatementSourceConflict } from "./acl-statement-source-server";
const config = { origin: "https://api.example.test", tenant: "01234567-89ab-cdef-0123-456789abcdef", scope: "forum", apiKey: "dedicated-key" };
const snapshot = { completeThrough: 100, history: { completeThrough: 100, accounts: [], links: [] }, rows: [] };
const signal = () => new AbortController().signal;
const answer = () => Response.json({ snapshot, fence: "a".repeat(64) });

test("fixed owner endpoints carry only service credentials and preserve snapshot time/fence", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const source = createAclStatementSource(config, async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return String(url).endsWith("snapshot") ? answer() : Response.json({ ok: true });
  }, () => 100);
  const held = await source.read(100, signal()); assert.deepEqual(held.snapshot, snapshot);
  assert.equal(held.fence, "100." + "a".repeat(64));
  let guards = 0;
  assert.equal(await source.append(held.fence, [{ kind: "object", soul: "test", record: {} }], () => { guards++; }, signal()), true);
  assert.equal(guards, 2);
  assert.equal(requests[0].url, config.origin + "/api/v1/acl/sociacl/statements/forum/snapshot");
  for (const { init } of requests) {
    assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit"); assert.equal(init.cache, "no-store");
    assert.equal(new Headers(init.headers).get("x-api-key"), config.apiKey);
    assert.equal(new Headers(init.headers).get("x-tenant-id"), config.tenant);
  }
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { evaluatedAt: 100 });
  assert.equal(JSON.parse(String(requests[1].init.body)).fence, "a".repeat(64));
});
test("configuration is explicit and rejects unsafe endpoints and partial activation", () => {
  assert.equal(configuredAclStatementSource({}), undefined);
  assert.equal(configuredAclStatementSource({ S3RCH_AUTHORITY_BACKEND: "legacy" }), undefined);
  for (const env of [{ S3RCH_AUTHORITY_BACKEND: "bad" }, { S3RCH_AUTHORITY_BACKEND: "acl" }]) assert.throws(() => configuredAclStatementSource(env));
  for (const bad of [{ origin: "http://api.test" }, { origin: "https://user:secret@api.test" }, { origin: "https://api.test/path" },
    { origin: "https://api.test:8443" }, { scope: "../other" }, { tenant: "wrong" }, { apiKey: "bad\nkey" }])
    assert.throws(() => createAclStatementSource({ ...config, ...bad }));
  for (const key of ["origin", "tenant", "scope", "apiKey"])
    assert.throws(() => createAclStatementSource({ ...config, [key]: undefined } as any));
  assert.ok(configuredAclStatementSource({ S3RCH_AUTHORITY_BACKEND: "acl", S3RCH_STATEMENT_SOURCE_ORIGIN: config.origin,
    S3RCH_STATEMENT_SOURCE_TENANT_ID: config.tenant, S3RCH_STATEMENT_SOURCE_SCOPE: config.scope, S3RCH_STATEMENT_SOURCE_API_KEY: config.apiKey }));
});
test("changed or unavailable source never triggers a retry or legacy fallback", async () => {
  let calls = 0;
  const source = createAclStatementSource(config, async () => { calls++; return new Response(null, { status: 409 }); }, () => 100);
  assert.equal(await source.append("100." + "a".repeat(64), [{}] as any, () => {}, signal()), false);
  await assert.rejects(source.read(100, signal()), StatementSourceConflict); assert.equal(calls, 2);
  for (const status of [302, 403, 503]) {
    const failed = createAclStatementSource(config, async () => new Response(null, { status }), () => 100);
    await assert.rejects(failed.read(100, signal()), /unavailable/);
  }
});
test("stale/malformed snapshots and append acknowledgements fail closed", async () => {
  for (const value of [{ snapshot: { ...snapshot, completeThrough: 99 }, fence: "a".repeat(64) },
    { snapshot, fence: "bad" }, { snapshot, fence: ["a".repeat(64)] }, { snapshot: { ...snapshot, history: {} }, fence: "a".repeat(64) },
    { snapshot: { ...snapshot, rows: Array(1025).fill({}) }, fence: "a".repeat(64) }]) {
    const source = createAclStatementSource(config, async () => Response.json(value), () => 100);
    await assert.rejects(source.read(100, signal()), /Invalid statement snapshot/);
  }
  for (const response of [() => new Response("not JSON", { headers: { "Content-Type": "application/json" } }),
    () => new Response("{}", { headers: { "Content-Type": "text/plain" } }),
    () => Response.json({}, { headers: { "Content-Encoding": "gzip" } }), () => new Response("x".repeat(4*1024*1024+4097), { headers: { "Content-Type": "application/json" } })]) {
    await assert.rejects(createAclStatementSource(config, async () => response(), () => 100).read(100, signal()));
  }
  const source = createAclStatementSource(config, async () => Response.json({ ok: false }), () => 100);
  await assert.rejects(source.append("100." + "a".repeat(64), [{}] as any, () => {}, signal()), /Invalid statement append response/);
});
test("local expiry, malformed writes and caller guard stop requests", async () => {
  let calls = 0;
  const source = createAclStatementSource(config, async () => { calls++; return answer(); }, () => 100);
  await assert.rejects(source.read(99, signal()), StatementSourceConflict);
  await assert.rejects(source.append("bad", [], () => {}, signal()));
  await assert.rejects(source.append(["100." + "a".repeat(64)] as any, [], () => {}, signal()));
  for (const rows of [[], Array(66).fill({}), [{ huge: "x".repeat(65537) }]])
    await assert.rejects(source.append("100." + "a".repeat(64), rows as any, () => {}, signal()));
  await assert.rejects(source.append("100." + "a".repeat(64), [{}] as any, () => { throw Error("revoked"); }, signal()), /revoked/);
  assert.equal(calls, 0);
});
test("abort cancels stalled response bodies and discards delayed responses", async () => {
  const controller = new AbortController(); let cancelled = 0, entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const source = createAclStatementSource(config, async () => new Response(new ReadableStream({ pull() { entered(); }, cancel() { cancelled++; } }, { highWaterMark: 0 }),
    { headers: { "Content-Type": "application/json" } }), () => 100);
  const pending = source.read(100, controller.signal); await reading; controller.abort();
  await assert.rejects(pending); assert.ok(cancelled >= 1);
  let at = 100;
  const delayed = createAclStatementSource(config, async () => { at = 101; return answer(); }, () => at);
  await assert.rejects(delayed.read(100, signal()), StatementSourceConflict);
});

test("abort releases a response returned late by a fetch implementation", async () => {
  let deliver!: (response: Response) => void, cancelled = 0;
  const controller = new AbortController();
  const source = createAclStatementSource(config, () => new Promise(resolve => { deliver = resolve; }), () => 100);
  const reading = source.read(100, controller.signal);
  controller.abort(); await assert.rejects(reading);
  deliver(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "Content-Type": "application/json" } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1);
});
