import test from "node:test";
import assert from "node:assert/strict";
import { createGunHealthProbe } from "./gun-health";
const url="https://test.s3r.ch/_peer/api/health";
const good={status:"ok",dependencies:{gun:{status:"ok"}}};
test("Gun probe checks the external dependency, caches and shares in-flight work",async()=>{
  let calls=0,time=0;const probe=createGunHealthProbe((async(input,options)=>{
    calls++;assert.equal(String(input),url);assert.equal(options?.redirect,"error");assert.equal(options?.credentials,"omit");return Response.json(good);
  }) as typeof fetch,()=>time);
  assert.equal((await probe(undefined)).health,"not-configured");assert.equal(calls,0);
  const results=await Promise.all([probe(url),probe(url)]);assert.equal(calls,1);assert.deepEqual(results[0],results[1]);
  assert.equal(results[0].status,"external");assert.equal(results[0].health,"ok");await probe(url);assert.equal(calls,1);
  time=15_000;await probe(url);assert.equal(calls,2);
});
test("Gun probe refuses redirects, malformed or oversized bodies and unhealthy peers",async()=>{
  for(const response of [new Response(null,{status:302}),Response.json({status:"ok"}),Response.json({...good,status:"unavailable"}),new Response("{",{status:200}),new Response("x".repeat(4097))]){
    const probe=createGunHealthProbe((async()=>response) as typeof fetch);assert.equal((await probe(url)).health,"unavailable");
  }
  const probe=createGunHealthProbe((async()=>{throw Error("private origin details");}) as typeof fetch);
  assert.equal(JSON.stringify(await probe(url)).includes("private"),false);
  for(const invalid of ["http://test.s3r.ch/api/health","https://user:pass@test.s3r.ch/api/health","https://test.s3r.ch/api/health?token=private","https://test.s3r.ch/private","invalid"]){
    const noCalls=createGunHealthProbe((async()=>{assert.fail("invalid URL fetched");}) as typeof fetch);
    assert.equal((await noCalls(invalid)).health,"unavailable");
  }
});
