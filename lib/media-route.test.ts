import { POST as catalogPost } from "../app/api/media/catalog/route";
import assert from "node:assert/strict";
import test from "node:test";
import { GET, PUT, POST, DELETE } from "../app/api/media/[object]/route";
import { SignJWT } from "jose";
import { configuredTestMediaBinding, createTestMediaReader } from "./media-wrap-server";
import { seaSessionCookieNames } from "./identity/sea-session-http";

const principal = "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.sBy9HAHlgGVxGBS1g_Bh6dQxzKmUzqExNEm_l8hArgo";
test("the allocated TEST deployment binds exactly one synthetic media caller", () => {
  const apiKey = "synthetic-unit-key";
  const tenant = "afee9b29-1706-5590-bbbf-e58df8945ac0", origin = "https://api.test.hyperme.sh";
  const site = "https://test.s3r.ch";
  const env = {
    WEBSITE_SITE_NAME: "s3rch-fyberlabs-test",
    S3RCH_TEST_MEDIA_OWNER_PRINCIPAL: principal,
    S3RCH_TEST_MEDIA_ACL_API_KEY: apiKey,
    S3RCH_MEDIA_STORAGE_MODE: "allocated-v1",
    S3RCH_MEDIA_STORAGE_ORIGIN: origin,
    S3RCH_MEDIA_STORAGE_TENANT_ID: tenant,
    S3RCH_IDENTITY_REPLAY_BACKEND: "spanopticon",
    S3RCH_IDENTITY_REPLAY_TENANT_ID: tenant,
  };
  const configured = configuredTestMediaBinding(env)!;
  assert.equal(configured.siteOrigin, site);
  assert.deepEqual(JSON.parse(configured.raw), {
    origin, tenant, readers: [{ principal, apiKey }],
  });
  for (const override of [
    { WEBSITE_SITE_NAME: "s3rch-fyberlabs" },
    { S3RCH_TEST_MEDIA_OWNER_PRINCIPAL: "foreign" },
    { S3RCH_TEST_MEDIA_ACL_API_KEY: undefined },
    { S3RCH_TEST_MEDIA_ACL_API_KEY: "@Microsoft.KeyVault(SecretUri=unresolved)" },
    { S3RCH_MEDIA_STORAGE_MODE: "legacy" },
    { S3RCH_MEDIA_STORAGE_ORIGIN: "https://foreign.invalid" },
    { S3RCH_IDENTITY_REPLAY_TENANT_ID: "foreign" },
    { S3RCH_IDENTITY_REPLAY_BACKEND: undefined },
    { S3RCH_MEDIA_STORAGE_TENANT_ID: "foreign" },
    { S3RCH_MEDIA_READER_BINDINGS: "{}" },
  ]) assert.throws(() => configuredTestMediaBinding({ ...env, ...override }));
  assert.equal(configuredTestMediaBinding({ S3RCH_MEDIA_READER_BINDINGS: "existing" }), undefined);
});

test("the TEST media owner requires the current site-issued SEA session", async () => {
  const host = "https://test.s3r.ch", now = 1800000000, secret = "unit-identity-secret".repeat(3);
  const reader = createTestMediaReader(principal, secret, () => now);
  assert.throws(() => createTestMediaReader(principal, "@Microsoft.KeyVault(SecretUri=unresolved)"));
  async function signed(origin: string, issued: number, key = secret) {
    return new SignJWT({}).setProtectedHeader({ alg: "HS256", typ: "s3rch-identity-session-v1" })
      .setIssuer(origin).setAudience(origin).setSubject(principal).setJti("a".repeat(64))
      .setIssuedAt(issued).setExpirationTime(issued + 300).sign(new TextEncoder().encode(key));
  }
  const token = await signed(host, now), name = seaSessionCookieNames()[0];
  const signal = new AbortController().signal;
  const request = (value: string, origin = host, headers: Record<string, string> = {}) =>
    new Request(origin + "/api/media/owner/catalog", { headers: { cookie: name + "=" + value, ...headers } });
  assert.equal(await reader(request(token), signal), principal);
  assert.equal(await reader(request(token, "https://s3r.ch"), signal), null);
  assert.equal(await reader(request(token, host, { authorization: "Bearer refuse" }), signal), null);
  assert.equal(await reader(request(await signed(host, now - 300)), signal), null);
  assert.equal(await reader(request(await signed("https://s3r.ch", now)), signal), null);
  assert.equal(await reader(request(await signed(host, now, "foreign-test-key".repeat(3))), signal), null);
  assert.equal(await createTestMediaReader("foreign", secret, () => now)(request(token), signal), null);
});
test("media routes stay unavailable with missing or partial deployment configuration", async () => {
  const names = ["S3RCH_MEDIA_STORAGE_ORIGIN", "S3RCH_MEDIA_STORAGE_TENANT_ID", "S3RCH_MEDIA_STORAGE_API_KEY", "S3RCH_MEDIA_STORAGE_MODE"];
  const saved = names.map(name => process.env[name]);
  try {
    for (const name of names) delete process.env[name];
    for (const handle of [GET, PUT, POST, DELETE]) {
      const response = await handle(new Request("https://s3r.ch/api/media/object"), { params: Promise.resolve({ object: "object" }) });
      assert.equal(response.status, 503); assert.equal(await response.text(), "");
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
    for(const mode of ["invalid","allocated-v1"]) {
      process.env.S3RCH_MEDIA_STORAGE_MODE=mode;
      assert.equal((await GET(new Request("https://s3r.ch/api/media/object"), {params:Promise.resolve({object:"object"})})).status,503);
    }
    delete process.env.S3RCH_MEDIA_STORAGE_MODE;
    process.env.S3RCH_MEDIA_STORAGE_ORIGIN = "https://storage.example";
    assert.equal((await GET(new Request("https://s3r.ch/api/media/object"), { params: Promise.resolve({ object: "object" }) })).status, 503);
  } finally { names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }); }
});

test("reader catalog remains unavailable without reader bindings",async()=>{
  const saved=process.env.S3RCH_MEDIA_READER_BINDINGS;
  try {
    delete process.env.S3RCH_MEDIA_READER_BINDINGS;
    const response=await catalogPost(new Request("https://s3r.ch/api/media/catalog",{method:"POST"}));
    assert.equal(response.status,503);assert.equal(await response.text(),"");
    assert.equal(response.headers.get("cache-control"),"private, no-store");
  } finally {
    if(saved===undefined)delete process.env.S3RCH_MEDIA_READER_BINDINGS;else process.env.S3RCH_MEDIA_READER_BINDINGS=saved;
  }
});
