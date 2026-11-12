import assert from "node:assert/strict";
import test from "node:test";
import { createStartupIdentityClient } from "./startup-identity-client";
import type { StartupLoginBinding } from "./startup-linked-login";
import vector from "./vectors/forums.json";
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
function setup() {
  const expected: StartupLoginBinding = { binding_sha256: "a".repeat(64), mapping_sha256: "b".repeat(64),
    sea_public_key: vector.seaPubkey, tenant_id: id(1), network_id: "isolated",
    entra: { tenant_id: id(2), object_id: id(3) },
    organizations: ["fyberlabs", "hyperme.sh", "tennesseewindage"].map((slug, index) =>
      ({ slug, id: id(10 + index), tenant_id: id(1), roles: ["admin", "owner"] })),
  };
  const response = { ...expected, schema_version: 1, status: "resolved", permissions: [], person_id: id(4), broker_subject: "opaque-person" };
  return { expected, response, endpoint: "https://auth.example.invalid/auth/startup/identity", account: { sea_public_key: vector.seaPubkey } };
}

test("Auth lookup uses only the configured endpoint, current bearer and read method", async () => {
  const h = setup(); let calls = 0;
  const client = createStartupIdentityClient({ ...h, fetch: async (url, init) => {
    calls++;
    assert.equal(url, h.endpoint); assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store"); assert.equal(init?.credentials, "omit");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer short-lived-token");
    assert.equal(init?.body, undefined);
    return Response.json(h.response);
  } });
  const result = await client.resolve("short-lived-token", "opaque-person", h.account);
  assert.equal(result?.person_id, id(4)); assert.equal(result?.sea_public_key, vector.seaPubkey); assert.equal(calls, 1);
});

test("misconfiguration and invalid bearer refuse before a request", async () => {
  const h = setup();
  for (const endpoint of ["http://auth.example.invalid/auth/startup/identity", "https://user:pass@auth.example.invalid/auth/startup/identity",
    h.endpoint + "?redirect=other", h.endpoint + "#fragment", "https://auth.example.invalid/other", "not-url"]) {
    assert.throws(() => createStartupIdentityClient({ ...h, endpoint }));
  }
  assert.throws(() => createStartupIdentityClient({ ...h, expected: { ...h.expected, mapping_sha256: "bad" } }));
  const client = createStartupIdentityClient({ ...h, fetch: async () => { assert.fail("must not fetch"); } });
  for (const token of ["", "bad token", "bad\nheader", "x".repeat(16385)]) assert.equal(await client.resolve(token, "opaque-person", h.account), null);
  const abort = new AbortController(); abort.abort();
  assert.equal(await client.resolve("token", "opaque-person", h.account, abort.signal), null);
});

test("unavailable, redirect, oversized, malformed and wrong-account results deny", async () => {
  const h = setup();
  for (const response of [Response.json(h.response, { status: 403 }), Response.redirect("https://other.invalid"),
    new Response(JSON.stringify(h.response), { headers: { "content-type": "text/plain" } }), new Response(null),
    new Response("x".repeat(16385), { headers: { "content-type": "application/json" } }),
    new Response("not-json", { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }),
    Response.json({ ...h.response, entra: { ...h.response.entra, object_id: id(99) } })]) {
    const client = createStartupIdentityClient({ ...h, fetch: async () => response });
    assert.equal(await client.resolve("token", "opaque-person", h.account), null);
  }
  const client = createStartupIdentityClient({ ...h, fetch: async () => { throw Error("offline"); } });
  assert.equal(await client.resolve("token", "opaque-person", h.account), null);
});

test("caller cancellation stops a stalled body and never returns stale identity", async () => {
  const h = setup(), abort = new AbortController(); let cancelled = false;
  const client = createStartupIdentityClient({ ...h, fetch: async () => new Response(new ReadableStream({
    start() { queueMicrotask(() => abort.abort()); }, cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json" } }) });
  assert.equal(await client.resolve("token", "opaque-person", h.account, abort.signal), null);
  assert.equal(cancelled, true);
});

test("configuration and prior-account mutation cannot retarget an in-flight request", async () => {
  const h = setup(); let release!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const client = createStartupIdentityClient({ ...h, fetch: () => pending });
  const account = { ...h.account, person_id: id(4) };
  const result = client.resolve("token", "opaque-person", account);
  account.person_id = id(99);
  (h.expected.organizations[0] as { id: string }).id = id(99);
  release(Response.json({ ...h.response, person_id: id(99) }));
  assert.equal(await result, null);
});
