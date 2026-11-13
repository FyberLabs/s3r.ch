// HTTP and identity contracts: executed in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { createMediaWrapService, parseMediaReaderConfig } from "./media-wrap-service";
const principal="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const tenant="11111111-1111-4111-8111-111111111111";
const config={origin:"https://gateway.example",tenant,readers:[{principal,apiKey:"reader-one-key"}]};
const payload={context:{object,epoch:1,revisionId:"a".repeat(64)},readerEpub:"enrolled-key",expiresAt:102,wrapBase64:"e30="};
const request=(body:unknown={object},headers:Record<string,string>={})=>new Request("https://s3r.ch/api/media/read-wrap",{
  method:"POST",headers:{origin:"https://s3r.ch","content-type":"application/json",...headers},body:JSON.stringify(body)});
test("only the configured subject credential is sent, with an object-only body",async()=>{
  let resolves=0;
  const service=createMediaWrapService(config,"https://s3r.ch",async()=>{resolves++;return principal;},async(url,init)=>{
    assert.equal(String(url),"https://gateway.example/api/v1/acl/sociacl/media/read-wrap");
    assert.deepEqual(JSON.parse(String(init?.body)),{object});
    assert.equal(new Headers(init?.headers).get("x-api-key"),"reader-one-key");
    assert.equal(init?.redirect,"error");return Response.json(payload);
  },()=>100);
  const response=await service(request());assert.equal(response.status,200);
  assert.deepEqual(await response.json(),payload);assert.equal(resolves,2);
  assert.equal(response.headers.get("cache-control"),"private, no-store");
});
test("forged reader, origin, malformed body and missing principal never reach provider",async()=>{
  let calls=0;const fetcher=async()=>{calls++;return Response.json(payload);};
  const service=createMediaWrapService(config,"https://s3r.ch",async()=>principal,fetcher,()=>100);
  for(const req of [request({object,reader:principal}),request({object:"bad"}),request({object},{origin:"https://evil.example"}),
    request({object},{"content-encoding":"gzip"}),request({object},{"content-type":"text/plain"})])
    assert.notEqual((await service(req)).status,200);
  const missing=createMediaWrapService(config,"https://s3r.ch",async()=>null,fetcher,()=>100);
  assert.equal((await missing(request())).status,403);assert.equal(calls,0);
});
test("rotation, expiry and provider refusals withhold delivery",async()=>{
  let count=0;
  const rotated=createMediaWrapService(config,"https://s3r.ch",async()=>++count===1?principal:null,async()=>Response.json(payload),()=>100);
  assert.equal((await rotated(request())).status,403);
  for(const response of [new Response(null,{status:403}),Response.json({...payload,expiresAt:100}),
    Response.json({...payload,expiresAt:104}),Response.json({...payload,extra:true}),new Response("x")]){
    const service=createMediaWrapService(config,"https://s3r.ch",async()=>principal,async()=>response,()=>100);
    assert.notEqual((await service(request())).status,200);
  }
});
test("same-reader concurrent delivery is bounded and capacity is released",async()=>{
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  const service=createMediaWrapService(config,"https://s3r.ch",async()=>principal,async()=>{await held;return Response.json(payload);},()=>100);
  const first=service(request());await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await service(request())).status,429);release();assert.equal((await first).status,200);
  assert.equal((await service(request())).status,200);
});
test("configuration rejects shared credentials, invalid tenant and unsafe origins",()=>{
  assert.deepEqual(parseMediaReaderConfig(JSON.stringify(config)),config);
  for(const value of [{...config,tenant:"wallet"},{...config,origin:"http://gateway.example"},
    {...config,readers:[]},{...config,readers:[...config.readers,...config.readers]},
    {...config,readers:[{principal,apiKey:"key\n"}]},{...config,extra:true},null])
    assert.throws(()=>parseMediaReaderConfig(JSON.stringify(value)));
});
