import { POST as catalogPost } from "../app/api/media/catalog/route";
import assert from "node:assert/strict";
import test from "node:test";
import { GET, PUT, POST, DELETE } from "../app/api/media/[object]/route";
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
