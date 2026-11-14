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

test("catalog uses fixed credentials, exact bounded pages and private responses",async()=>{
  const result={at:100,objects:[object],nextPage:1};
  let calls=0;
  const handle=service(async(url,init)=>{calls++;assert.equal(actionName(url),"catalog");
    assert.deepEqual(JSON.parse(String(init?.body)),{page:0});return Response.json(result);});
  const response=await handle("catalog",request({page:0}));
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{...result,principal});
  assert.equal(response.headers.get("cache-control"),"private, no-store");
  for(const body of [{page:-1},{page:16},{page:true},{page:0.5},{page:0,owner:principal},{object}])
    assert.equal((await handle("catalog",request(body))).status,400);
  assert.equal(calls,1);
  for(const bad of [{...result,nextPage:null},{...result,at:-1},{...result,objects:[object,object]},
    {...result,objects:["private-secret"]},{...result,objects:new Array(5).fill(object)},{...result,secret:"hidden"}]) {
    const rejected=await service(async()=>Response.json(bad))("catalog",request({page:0}));
    assert.equal(rejected.status,403);assert.equal(await rejected.text(),"");
  }
  assert.equal((await service(async()=>Response.json({at:100,objects:[],nextPage:null}))("catalog",request({page:15}))).status,200);
});

test("cancellation drafts bind the stable owner, object and recipient",async()=>{
  const grant={object,owner:principal,accessor:principal,from:0,until:1,stated:0,epoch:1,grantRevision:2,itemCiphertextDigest:"a".repeat(64)};
  const draft={at:100,fence:view.fence,ownerPub:principal,grant};
  assert.equal((await service(async()=>Response.json(draft))("cancel-view",request({object,reader:principal}))).status,200);
  for(const bad of [{...draft,ownerPub:"bad"},{...draft,grant:{...grant,owner:"other"}},
    {...draft,grant:{...grant,accessor:"other"}},{...draft,grant:{...grant,object:"other"}},
    {...draft,grant:{...grant,stated:1}},{...draft,grant:{...grant,grantRevision:1}},
    {...draft,grant:{...grant,until:0}},{...draft,grant:{...grant,from:-1}},
    {...draft,grant:{...grant,epoch:0}},{...draft,grant:{...grant,itemCiphertextDigest:"bad"}}])
    assert.equal((await service(async()=>Response.json(bad))("cancel-view",request({object,reader:principal}))).status,403);
});

test("allocation uses the bound principal and separate ACL route without browser authority settings", async()=>{
  const record={object,owner:principal,issuedAt:100,sig:"signed"};let calls=0;
  const handle=service(async(url,init)=>{calls++;assert.equal(String(url),config.origin+"/api/v1/acl/sociacl/media/allocate");
    assert.deepEqual(JSON.parse(String(init?.body)),record);return Response.json({object,accepted:true});});
  assert.equal((await handle("allocate",request(record))).status,200);
  assert.equal((await handle("allocate",request({...record,owner:"foreign"}))).status,403);
  assert.equal((await handle("allocate",request({...record,policy:{}}))).status,400);
  assert.equal(calls,1);
  assert.equal((await service(async()=>Response.json({object:"foreign",accepted:true}))("allocate",request(record))).status,403);
  assert.equal((await service(async()=>Response.json({object,accepted:false}))("allocate",request(record))).status,403);
});

test("upload reconciliation keeps fixed credentials and rejects extra authority or malformed results",async()=>{
  const body={object,operation:"epoch",payload:{document:{},finalization:{}}};let calls=0;
  const handle=service(async(url,init)=>{
    calls++;assert.ok(String(url).endsWith("/owner/upload-state"));assert.deepEqual(JSON.parse(String(init?.body)),body);
    assert.equal(new Headers(init?.headers).get("x-api-key"),"owner-key");return Response.json({at:100,state:"applied"});
  });
  assert.equal((await handle("upload-state",request(body))).status,200);
  for(const changes of [{owner:"foreign"},{at:1},{operation:"status"},{payload:[]}])
    assert.equal((await handle("upload-state",request({...body,...changes}))).status,400);
  assert.equal(calls,1);
  for(const result of [{at:100,state:"allowed"},{at:-1,state:"applied"},{at:100,state:"applied",secret:"no"}])
    assert.equal((await service(async()=>Response.json(result))("upload-state",request(body))).status,403);
});

test("deletion proxy binds drafts to configured tenant and session owner",async()=>{
  const claims={tenant:config.tenant,object,owner:principal,objectVersion:1,fence:view.fence,issuedAt:100000,expiresAt:160000};
  const draft={at:100,ownerPub:principal,claims};
  assert.equal((await service(async()=>Response.json(draft))("delete-view",request())).status,200);
  assert.equal((await service(async()=>Response.json({...draft,claims:{...claims,tenant:"22222222-2222-4222-8222-222222222222"}}))("delete-view",request())).status,403);
  const body={object,at:100,proof:{deletionBytes:"aa",signature:"b".repeat(128)}};
  const result={accepted:true,command:"c".repeat(64),cleanup:"pending"};
  const forwarded=service(async(url,init)=>{assert.ok(String(url).endsWith("/owner/delete"));assert.deepEqual(JSON.parse(String(init?.body)),body);return Response.json(result);});
  assert.deepEqual(await (await forwarded("delete",request(body))).json(),result);
  for(const changed of [{...body,at:true},{...body,writer:principal},{...body,proof:[]},{...body,proof:{deletionBytes:"zz",signature:"b".repeat(128)}}])assert.equal((await forwarded("delete",request(changed))).status,400);
  assert.equal((await service(async()=>Response.json({...result,cleanup:"complete"}))("delete",request(body))).status,403);
});

test("cleanup proxy keeps fixed subject credentials and requires completed acknowledgement",async()=>{
  const result={accepted:true,command:"a".repeat(64),cleanup:"complete"};let calls=0;
  const handle=service(async(url,init)=>{calls++;assert.match(String(url),/owner\/cleanup$/);
    assert.deepEqual(JSON.parse(String(init?.body)),{object});assert.equal(new Headers(init?.headers).get("x-api-key"),"owner-key");
    return Response.json(result);});
  assert.deepEqual(await (await handle("cleanup",request({object}))).json(),result);
  assert.equal((await handle("cleanup",request({object,command:"b".repeat(64)}))).status,400);assert.equal(calls,1);
  for(const bad of [{...result,cleanup:"pending"},{...result,command:"bad"},{...result,accepted:1}])
    assert.equal((await service(async()=>Response.json(bad))("cleanup",request({object}))).status,403);
});
