// HTTP contracts: CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { createMediaOwnerService } from "./media-owner-service";
const principal="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const config={origin:"https://gateway.example",tenant:"11111111-1111-4111-8111-111111111111",readers:[{principal,apiKey:"owner-key"}]};
const view={at:100,fence:"a".repeat(64),snapshot:{entries:[]},objectVersion:0,owner:principal,bindings:{}};
const mutation={object,at:100,fence:view.fence,operation:"grant",payload:{proof:"signed"}};
const publication={object,at:100,fence:view.fence,metadata:{digest:"b".repeat(64)},wrapBase64:"e30="};
const request=(body:unknown={object},headers:Record<string,string>={})=>new Request("https://s3r.ch/api/media/owner/view",{
  method:"POST",headers:{origin:"https://s3r.ch","content-type":"application/json",...headers},body:JSON.stringify(body)});
const service=(fetcher:typeof fetch=async()=>Response.json(view),resolve=async()=>principal)=>
  createMediaOwnerService(config,"https://s3r.ch",resolve,fetcher,()=>100);
test("fixed owner credential and bounded action preserve exact signed payload",async()=>{
  for(const [action,body,result] of [["view",{object},view],["mutate",mutation,{accepted:true}],
    ["publish-wrap",publication,{digest:"b".repeat(64),record:"b".repeat(64)}]] as const){
    let calls=0,resolves=0;
    const handle=service(async(url,init)=>{calls++;assert.equal(String(url),config.origin+"/api/v1/acl/sociacl/media/owner/"+action);
      assert.deepEqual(JSON.parse(String(init?.body)),body);assert.equal(new Headers(init?.headers).get("x-api-key"),"owner-key");
      assert.equal(new Headers(init?.headers).get("x-tenant-id"),config.tenant);assert.equal(init?.redirect,"error");
      return Response.json(result);},async()=>{resolves++;return principal;});
    const response=await handle(action,request(body));assert.equal(response.status,200);assert.deepEqual(await response.json(),result);
    assert.equal(response.headers.get("cache-control"),"private, no-store");assert.equal(calls,1);assert.equal(resolves,2);
  }
});
test("unknown actions, spoofed owner and malformed bodies never call provider",async()=>{
  let calls=0;const handle=service(async()=>{calls++;return Response.json(view);});
  for(const [action,body] of [["provision",{}],["view",{object,owner:principal}],["view",{object:"invalid"}],
    ["mutate",{...mutation,at:-1}],["mutate",{...mutation,fence:"bad"}],["mutate",{...mutation,operation:"policy"}],
    ["mutate",{...mutation,payload:[]}],["publish-wrap",{...publication,metadata:[]}],
    ["publish-wrap",{...publication,wrapBase64:"!"}]] as const)assert.notEqual((await handle(action,request(body))).status,200);
  const badHeaders: Record<string,string>[] = [{origin:"https://evil.example"},{"content-encoding":"gzip"},{"content-type":"text/plain"}];
  for(const headers of badHeaders)
    assert.notEqual((await handle("view",request({object},headers))).status,200);
  assert.equal((await handle("view",new Request("https://s3r.ch",{method:"GET"}))).status,405);assert.equal(calls,0);
});
test("refused upstream and malformed successes never expose upstream bodies",async()=>{
  for(const response of [new Response("secret",{status:409}),new Response("secret",{status:500}),new Response("secret"),
    Response.json({...view,owner:"attacker"}),Response.json({...view,at:-1}),Response.json({...view,fence:"bad"}),
    Response.json({...view,objectVersion:-1}),Response.json({...view,snapshot:{entries:new Array(65).fill({})}}),
    Response.json({...view,bindings:[]})]){
    const status=response.status;const result=await service(async()=>response)("view",request());
    assert.equal(result.status,status===409?409:403);assert.equal(await result.text(),"");
  }
  assert.equal((await service(async()=>Response.json({accepted:false}))("mutate",request(mutation))).status,403);
  assert.equal((await service(async()=>Response.json({record:"b".repeat(64),digest:"c".repeat(64)}))("publish-wrap",request(publication))).status,403);
  assert.equal((await service(async()=>{throw Error("secret");})("view",request())).status,503);
});
test("session changes and unbound sessions refuse",async()=>{
  let resolves=0;
  assert.equal((await service(undefined,async()=>++resolves===1?principal:"unknown")("view",request())).status,403);
  assert.equal((await service(undefined,async()=>"unknown")("view",request())).status,403);
  assert.throws(()=>createMediaOwnerService(config,"http://s3r.ch",async()=>principal));
});
test("per-owner operations share bounded capacity and release it",async()=>{
  let release!:()=>void;const waiting=new Promise<void>(r=>{release=r;});
  const handle=service(async()=>{await waiting;return Response.json(view);});
  const first=handle("view",request());await new Promise(r=>setImmediate(r));
  assert.equal((await handle("mutate",request(mutation))).status,429);release();assert.equal((await first).status,200);
  assert.equal((await handle("view",request())).status,200);
});
test("status drafts bind the requested recipient, current source clock and object",async()=>{
  const status={object,epoch:1,revisionId:"b".repeat(64),accessor:principal,grantRevision:1,stated:1,signedAt:100000,maxAgeMs:60000,
    zookie:{object,objectVersion:3,snapshotHash:"c".repeat(64)}};
  const result={at:100,fence:view.fence,ownerPub:principal,status};
  let calls=0;const handle=service(async(url,init)=>{calls++;assert.equal(actionName(url),"status-view");
    assert.deepEqual(JSON.parse(String(init?.body)),{object,reader:principal});return Response.json(result);});
  assert.equal((await handle("status-view",request({object,reader:principal}))).status,200);
  assert.equal((await handle("status-view",request({object,reader:"bad"}))).status,400);assert.equal(calls,1);
  for(const bad of [{...result,ownerPub:"bad"},{...result,at:99},{...result,status:{...status,accessor:"other"}},
    {...result,status:{...status,maxAgeMs:60001}},{...result,status:{...status,signedAt:99999}},
    {...result,status:{...status,zookie:{...status.zookie,objectVersion:-1}}}])
    assert.equal((await service(async()=>Response.json(bad))("status-view",request({object,reader:principal}))).status,403);
});
function actionName(url: RequestInfo | URL) { return String(url).split("/").at(-1); }

test("owner views preserve source clocks across transport and session boundaries",async()=>{
  const status={object,epoch:1,revisionId:"b".repeat(64),accessor:principal,grantRevision:1,stated:1,signedAt:100000,maxAgeMs:60000,
    zookie:{object,objectVersion:3,snapshotHash:"c".repeat(64)}};
  for(const action of ["view","status-view"]) {
    const result=action==="view" ? view : {at:100,fence:view.fence,ownerPub:principal,status};
    for(const start of [0,99.9,1000000]) {
      let now=start;
      const handle=createMediaOwnerService(config,"https://s3r.ch",async()=>{now+=0.2;return principal;},
        async()=>{now+=0.2;return Response.json(result);},()=>now);
      const response=await handle(action,request(action==="view"?{object}:{object,reader:principal}));
      assert.equal(response.status,200);assert.deepEqual(await response.json(),result);
    }
    for(const elapsed of [4,-1,NaN]) {
      let now=0;
      const handle=createMediaOwnerService(config,"https://s3r.ch",async()=>principal,
        async()=>{now=elapsed;return Response.json(result);},()=>now);
      assert.equal((await handle(action,request(action==="view"?{object}:{object,reader:principal}))).status,403);
    }
  }
});
