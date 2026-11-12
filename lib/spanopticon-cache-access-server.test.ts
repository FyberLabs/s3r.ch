import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSpanopticonRecordStore } from "./spanopticon-record-store-server";
const config = { origin: "https://storage.example", tenant: "11111111-1111-4111-8111-111111111111", apiKey: "private.key" };
const envelope = new Uint8Array([...new TextEncoder().encode("SPANREC1"), ...new Uint8Array(32), 1, 2, 3]);
function descriptor() {
  const expires_at = Math.floor(Date.now() / 1000) + 60;
  const url = new URL("https://cachetest.blob.core.windows.net/private-cache/tenant-records/v1/" + config.tenant.replaceAll("-", "") + "/cache/feed");
  url.search = new URLSearchParams({ sp: "r", sr: "b", spr: "https", se: new Date(expires_at * 1000).toISOString(), sig: "opaque-unit-signature" }).toString();
  return { version: 1, provider: "azure_blob", method: "GET", encoding: "spanrec1", size: envelope.length, expires_at, url: url.href, headers: { "If-Match": '"provider-version"' } };
}
const response = () => new Response(envelope, { headers: { etag: '"provider-version"', "content-length": String(envelope.length) } });
function client(grant = descriptor(), provider: () => Response = response, seen: RequestInit[] = []) {
  return createSpanopticonRecordStore(config, (async (url: string, init: RequestInit) => {
    seen.push(init);
    if (url.startsWith(config.origin)) {
      assert.equal(url, config.origin + "/api/v1/storage/records/cache/feed/access");
      assert.equal(new Headers(init.headers).get("x-api-key"), config.apiKey);
      return Response.json(grant);
    }
    assert.equal(url, grant.url);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-api-key"), null);
    assert.equal(headers.get("x-tenant-id"), null);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("if-match"), '"provider-version"');
    assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit");
    assert.equal(init.referrerPolicy, "no-referrer"); assert.equal(init.cache, "no-store");
    return provider();
  }) as typeof fetch);
}

test("cache reads go directly to one authorized Blob without tenant credentials", async () => {
  const seen: RequestInit[] = [];
  assert.deepEqual(await client(descriptor(), response, seen).get("cache", "feed"), {
    bytes: new Uint8Array([1, 2, 3]), revision: createHash("sha256").update(envelope).digest("hex"),
  });
  assert.equal(seen.length, 2);
});

test("unsafe grants fail before contacting any provider", async () => {
  const invalid = [
    { method: "PUT" }, { provider: "unknown" }, { encoding: "json" }, { version: 2 }, { size: 40 }, { size: 8388649 },
    { expires_at: 0 }, { expires_at: Math.floor(Date.now() / 1000) + 600 },
    { headers: { "If-Match": "*" } }, { headers: { "If-Match": '"provider-version"', Authorization: "secret" } },
    ...["http://cachetest.blob.core.windows.net/x", "https://localhost/x", "https://cachetest.blob.core.windows.net.evil.test/x"].map(url => ({ url })),
  ];
  for (const change of invalid) {
    const seen: RequestInit[] = [];
    await assert.rejects(client({ ...descriptor(), ...change } as ReturnType<typeof descriptor>, response, seen).get("cache", "feed"), { message: "Tenant record storage unavailable" });
    assert.equal(seen.length, 1);
  }
  for (const mutate of [
    (url: URL) => { url.pathname = url.pathname.replace(config.tenant.replaceAll("-", ""), "0".repeat(32)); },
    (url: URL) => { url.pathname = url.pathname.replace("/cache/feed", "/recovery/feed"); },
    (url: URL) => { url.searchParams.set("sp", "rw"); },
    (url: URL) => { url.searchParams.append("sp", "r"); },
    (url: URL) => { url.searchParams.set("se", "invalid"); },
    (url: URL) => { url.searchParams.delete("sig"); },
    (url: URL) => { url.username = "user"; },
  ]) {
    const grant = descriptor(), url = new URL(grant.url), seen: RequestInit[] = [];
    mutate(url); grant.url = url.href;
    await assert.rejects(client(grant, response, seen).get("cache", "feed"));
    assert.equal(seen.length, 1);
  }
});

test("provider failures and corrupt envelopes never become missing or proxied reads", async () => {
  for (const provider of [
    ...[301, 403, 404, 412, 500].map(status => () => new Response("secret", { status })),
    () => new Response(envelope, { headers: { etag: '"other"' } }),
    () => new Response(envelope, { headers: { etag: '"provider-version"', "content-encoding": "gzip" } }),
    () => new Response(new Uint8Array(envelope.length), { headers: { etag: '"provider-version"' } }),
    () => new Response(envelope.slice(1), { headers: { etag: '"provider-version"' } }),
    () => new Response(envelope, { headers: { etag: '"provider-version"', "content-length": "99999999" } }),
  ]) {
    const seen: RequestInit[] = [];
    await assert.rejects(client(descriptor(), provider, seen).get("cache", "feed"), { message: "Tenant record storage unavailable" });
    assert.equal(seen.length, 2);
  }
});

test("older services and unsupported providers retain proxied reads", async () => {
  for (const status of [404, 501]) {
    const urls: string[] = [];
    const store = createSpanopticonRecordStore(config, (async (url: string) => {
      urls.push(url);
      return url.endsWith("/access") ? new Response(null, { status }) : new Response(new Uint8Array([9]), { headers: { etag: '"' + "a".repeat(64) + '"' } });
    }) as typeof fetch);
    assert.deepEqual((await store.get("cache", "feed"))?.bytes, new Uint8Array([9]));
    assert.equal(urls.length, 2);
    urls.length = 0;
    await store.get("recovery", "feed");
    assert.equal(urls.length, 1);
  }
});
