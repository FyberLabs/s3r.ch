import { POST as catalogPost } from "../app/api/media/catalog/route";
import assert from "node:assert/strict";
import test from "node:test";
import { GET, PUT, POST, DELETE } from "../app/api/media/[object]/route";
import { configuredMediaReaderBindings } from "./media-wrap-server";

test("the allocated TEST deployment binds exactly one synthetic media caller", () => {
  const principal = "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.sBy9HAHlgGVxGBS1g_Bh6dQxzKmUzqExNEm_l8hArgo";
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
    S3RCH_STATEMENT_SOURCE_TENANT_ID: tenant,
  };
  assert.deepEqual(JSON.parse(configuredMediaReaderBindings(env, site)!), {
    origin, tenant, readers: [{ principal, apiKey }],
  });
  for (const override of [
    { WEBSITE_SITE_NAME: "s3rch-fyberlabs" },
    { S3RCH_TEST_MEDIA_OWNER_PRINCIPAL: "foreign" },
    { S3RCH_TEST_MEDIA_ACL_API_KEY: undefined },
    { S3RCH_TEST_MEDIA_ACL_API_KEY: "@Microsoft.KeyVault(SecretUri=unresolved)" },
    { S3RCH_MEDIA_STORAGE_MODE: "legacy" },
    { S3RCH_MEDIA_STORAGE_ORIGIN: "https://foreign.invalid" },
    { S3RCH_STATEMENT_SOURCE_TENANT_ID: "foreign" },
    { S3RCH_MEDIA_STORAGE_TENANT_ID: "foreign" },
    { S3RCH_MEDIA_READER_BINDINGS: "{}" },
  ]) assert.throws(() => configuredMediaReaderBindings({ ...env, ...override }, site));
  assert.throws(() => configuredMediaReaderBindings(env, "https://s3r.ch"));
  assert.equal(configuredMediaReaderBindings({ S3RCH_MEDIA_READER_BINDINGS: "existing" }), "existing");
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
