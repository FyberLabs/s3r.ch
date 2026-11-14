import test from "node:test";
import assert from "node:assert/strict";
import { GET } from "../app/api/media/config/route";

test("runtime media configuration exposes only a validated tenant",async()=>{
  const original=process.env.S3RCH_MEDIA_STORAGE_TENANT_ID;
  try {
    for(const value of [undefined,"private-invalid-value","11111111-1111-4111-8111-111111111111"]) {
      if(value===undefined)delete process.env.S3RCH_MEDIA_STORAGE_TENANT_ID;else process.env.S3RCH_MEDIA_STORAGE_TENANT_ID=value;
      const response=await GET();
      assert.equal(response.headers.get("cache-control"),"no-store");
      assert.deepEqual(await response.json(),{tenant:value?.startsWith("11111111-")?value:null});
    }
  }finally{if(original===undefined)delete process.env.S3RCH_MEDIA_STORAGE_TENANT_ID;else process.env.S3RCH_MEDIA_STORAGE_TENANT_ID=original;}
});
