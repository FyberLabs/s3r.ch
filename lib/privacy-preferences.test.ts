import test from "node:test";
import assert from "node:assert/strict";
import { privacyPreferences } from "./privacy-preferences";
import { GET } from "../app/api/privacy/preferences/route";
test("either GPC signal opts out and missing signals never authorize sale or sharing",()=>{
  for(const header of [null,"0","1","true"])for(const browser of [undefined,false,true,"true",1]){
    const result=privacyPreferences(header,browser);
    assert.equal(result.globalPrivacyControl,header==="1" || browser===true);
    assert.equal(result.saleAllowed,false);assert.equal(result.sharingAllowed,false);assert.ok(Object.isFrozen(result));
  }
});
test("request preferences are private, not cached or persisted",async()=>{
  const response=GET(new Request("https://s3r.ch/api/privacy/preferences",{headers:{"Sec-GPC":"1"}}));
  assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"private, no-store");
  assert.equal(response.headers.get("vary"),"Sec-GPC");assert.equal(response.headers.get("set-cookie"),null);
  assert.deepEqual(await response.json(),{globalPrivacyControl:true,saleAllowed:false,sharingAllowed:false});
});
