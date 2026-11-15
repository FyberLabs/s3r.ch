// Protected HTTP and signing contracts run in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import {createMediaGroupService} from "./media-group-service";
import {parseGroupCommand,parseGroupCommandResult,type GroupCommandAction} from "./media-group-command";
import {signOwnerGroupRow} from "./media-group-signing";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const other="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const scope={predicate:"same-group" as const,set:object.replace("media_","set_")};
const config={origin:"https://acl.example",tenant:"11111111-1111-4111-8111-111111111111",readers:[{principal:owner,apiKey:"private-key"}]};
const fence="a".repeat(64),context={owner,ownerPub:owner,predicate:scope.predicate,setId:scope.set};
const policy={owner,setId:scope.set,predicate:scope.predicate,settleWindowMs:3600000,configRevision:0,signature:"1".repeat(128)};
const unsigned={role:"set",member:other,setOwner:owner,stated:1,hamState:1,cancels:[]};
const key=new Uint8Array(32);key[31]=1;
const row=signOwnerGroupRow("membership",unsigned,scope,object,owner,100,key,owner);
const draft={...unsigned,...scope,issuedAt:100};
const member={...scope,member:other,role:"set"};
const groupSnapshot={predicate:scope.predicate,setId:scope.set,setOwner:owner,ownerSigningPub:owner,ownerEncryptionPub:other,ownerIdentityHead:0,members:[]};
const groupManifest={object:scope.set,previousEpoch:0,epoch:1,deviceId:"device",revisionId:"b".repeat(64),keyCommitment:"c".repeat(64),settleWindowMs:3600000,aclSnapshot:"d".repeat(64),signature:"1".repeat(128)};
const groupFinalization={object:scope.set,previousEpoch:0,epoch:1,revisionId:groupManifest.revisionId,candidateRevisionIds:[groupManifest.revisionId],previousFinalizationId:"",finalizationId:"e".repeat(64),signature:"1".repeat(128)};
const groupKeyCommand={document:{manifest:groupManifest,snapshot:groupSnapshot},finalization:groupFinalization};
const itemView={at:100,expiresAt:102,fence,object,...scope,ownerPub:owner,
  item:{epoch:1,revisionId:"b".repeat(64),digest:"c".repeat(64)},
  group:{epoch:1,revisionId:"d".repeat(64),keyCommitment:"e".repeat(64)}};
const cases:readonly [GroupCommandAction,Record<string,unknown>,unknown][]=[
  ["create-view",{object,...scope},{at:100,context,fence}],
  ["create",{object,...scope,at:100,fence,config:policy},{accepted:true}],
  ["create-state",{object,...scope,config:policy},{at:100,state:"applied"}],
  ["member-view",{...member,stated:1},{at:100,draft,signerPub:owner,fence}],
  ["member-append",{...member,at:100,fence,row},{accepted:true}],
  ["member-state",{...member,row},{at:100,state:"absent",fence}],
  ["key-view",scope,{at:100,fence,snapshot:groupSnapshot,config:policy,previousEpoch:0,previousFinalizationId:""}],
  ["key-append",{...scope,at:100,fence,command:groupKeyCommand},{accepted:true}],
  ["key-state",{...scope,command:groupKeyCommand},{at:100,state:"absent",fence}],
  ["item-view",{object,...scope},itemView],
  ["item-authority-view",{object},{at:100,fence,objectVersion:1,projection:null,ownerPub:owner}],
];
const request=(body:unknown,headers:Record<string,string>={})=>new Request("https://s3r.ch/api/media/groups/create-view",{method:"POST",headers:{origin:"https://s3r.ch","content-type":"application/json",...headers},body:JSON.stringify(body)});
const service=(fetcher:typeof fetch,resolve=async()=>owner)=>createMediaGroupService(config,"https://s3r.ch",resolve,fetcher,()=>100);

test("six group commands retain exact payloads and fixed credentials",async()=>{
  for(const [action,body,result] of cases){
    let resolutions=0;
    const handle=service(async(url,init)=>{
      assert.equal(String(url),config.origin+"/api/v1/acl/sociacl/media/groups/"+action);
      assert.deepEqual(JSON.parse(String(init?.body)),body);
      assert.equal(new Headers(init?.headers).get("x-api-key"),"private-key");
      assert.equal(new Headers(init?.headers).get("x-tenant-id"),config.tenant);
      assert.equal(init?.redirect,"error");return Response.json(result);
    },async()=>{resolutions++;return owner;});
    const response=await handle(action,request(body));
    assert.equal(response.status,200);assert.deepEqual(await response.json(),result);assert.equal(resolutions,2);
    assert.equal(response.headers.get("cache-control"),"private, no-store");
  }
});
test("request parser rejects other parties, scopes, rows and authority fields",()=>{
  assert.throws(()=>parseGroupCommand("create",{object,...scope,"at,config,fence":{}},owner));
  for(const [action,body] of cases){
    assert.throws(()=>parseGroupCommand(action,{...body,writer:owner},owner));
    assert.throws(()=>parseGroupCommand(action,body,other));
    assert.throws(()=>parseGroupCommand(action,{...body,set:"invalid"},owner));
  }
  for(const patch of [{object:"bad"},{object:scope.set},{config:{}},{at:true},{fence:"bad"}])
    assert.throws(()=>parseGroupCommand("create",{...cases[1][1],...patch},owner));
  for(const patch of [{member:"bad"},{role:"owner"},{stated:2}])
    assert.throws(()=>parseGroupCommand("member-view",{...cases[3][1],...patch},owner));
  for(const changed of [{},{...row,soul:"bad"},{...row,kind:"object"},{...row,record:{...row.record,role:"member"}}])
    assert.throws(()=>parseGroupCommand("member-append",{...cases[4][1],row:changed},owner));
  const own={...unsigned,role:"member",member:owner};
  const signed=signOwnerGroupRow("membership",own,scope,object,owner,100,key,owner);
  assert.equal(parseGroupCommand("member-state",{...scope,role:"member",member:owner,row:signed},owner).member,owner);
});
test("result parser refuses mismatched drafts, stale time and malformed states",()=>{
  for(const [action,body,result] of cases){assert.throws(()=>parseGroupCommandResult(action,{...(result as object),extra:1},body,100));}
  for(const at of [-1,95,102,true])assert.throws(()=>parseGroupCommandResult("create-view",{at,context,fence},cases[0][1],100));
  for(const patch of [{owner:other},{ownerPub:"bad"},{setId:"bad"},{predicate:"named-circle"}])
    assert.throws(()=>parseGroupCommandResult("create-view",{at:100,context:{...context,...patch},fence},cases[0][1],100));
  for(const patch of [{role:"member"},{member:owner},{setOwner:other},{stated:0},{hamState:-1},{issuedAt:99},{cancels:["bad"]},{cancels:Array(65).fill(fence)},{cancels:[fence,fence]}])
    assert.throws(()=>parseGroupCommandResult("member-view",{at:100,draft:{...draft,...patch},signerPub:owner,fence},cases[3][1],100));
  assert.throws(()=>parseGroupCommandResult("member-view",{at:100,draft,signerPub:"bad",fence},cases[3][1],100));
  assert.throws(()=>parseGroupCommandResult("member-view",null,cases[3][1],100));
  assert.throws(()=>parseGroupCommandResult("create",{accepted:false},cases[1][1],100));
  assert.throws(()=>parseGroupCommandResult("member-state",{at:100,state:"unknown",fence},cases[5][1],100));
  assert.throws(()=>parseGroupCommandResult("member-state",{at:100,state:"applied",fence:"bad"},cases[5][1],100));
  assert.deepEqual(parseGroupCommandResult("create-state",{at:100,state:"absent",fence},cases[2][1],100),{at:100,state:"absent",fence});
  assert.throws(()=>parseGroupCommandResult("member-view",{at:100,draft:{...draft,stated:0,cancels:[fence]},signerPub:owner,fence},{...cases[3][1],stated:0},100));
});
test("BFF refuses spoofing and provider failures without exposing responses",async()=>{
  let calls=0;const handle=service(async()=>{calls++;return Response.json(cases[0][2]);});
  assert.equal((await handle("unknown",request({}))).status,404);
  assert.equal((await handle("create-view",new Request("https://s3r.ch",{headers:{origin:"https://s3r.ch"}}))).status,405);
  for(const headers of ([{origin:"https://evil.example"},{"content-type":"text/plain"},{"content-encoding":"gzip"}] as Record<string,string>[]))assert.notEqual((await handle("create-view",request(cases[0][1],headers))).status,200);
  assert.equal((await handle("create-view",request({...cases[0][1],writer:owner}))).status,400);
  assert.equal((await handle("create-view",request({padding:"x".repeat(19000)}))).status,400);
  assert.equal((await handle("create",request({object,...scope,"at,config,fence":{}}))).status,400);
  assert.equal(calls,0);
  for(const status of [403,409,429,500]){
    const response=await service(async()=>new Response("private detail",{status}))("create-view",request(cases[0][1]));
    assert.equal(response.status,status===500?503:status);assert.equal(await response.text(),"");
  }
  for(const result of [()=>new Response("{}"),()=>Response.json({bad:1}),()=>Response.json(cases[0][2],{headers:{"content-encoding":"gzip"}})])
    assert.equal((await service(async()=>result())("create-view",request(cases[0][1]))).status,503);
  assert.equal((await service(async()=>{throw Error("secret");})("create-view",request(cases[0][1]))).status,503);
  assert.equal((await service(async()=>Response.json(cases[0][2]),async()=>other)("create-view",request(cases[0][1]))).status,403);
  let n=0;assert.equal((await service(async()=>Response.json(cases[0][2]),async()=>++n===1?owner:other)("create-view",request(cases[0][1]))).status,403);
  assert.throws(()=>createMediaGroupService(config,"http://s3r.ch",async()=>owner));
});
test("preflight and per-principal concurrency remain bounded and release capacity",async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const handle=service(async()=>{await gate;return Response.json(cases[0][2]);});
  const first=handle("create-view",request(cases[0][1]));await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal((await handle("create-view",request(cases[0][1]))).status,429);
  release();assert.equal((await first).status,200);
  assert.equal((await handle("create-view",request(cases[0][1]))).status,200);
  let unblock!:()=>void;const waiting=new Promise<void>(resolve=>{unblock=resolve;});
  const held=service(async()=>Response.json(cases[0][2]),async()=>{await waiting;return owner;});
  const a=held("create-view",request(cases[0][1])),b=held("create-view",request(cases[0][1]));
  assert.equal((await held("create-view",request(cases[0][1]))).status,429);
  unblock();await Promise.all([a,b]);
});

test("group catalog validates the fixed principal and excludes unrelated rows",async()=>{
  const entry={...scope,owner,owned:true,invited:false,active:false};
  const result={at:100,groups:[entry],nextPage:1,principal:owner};
  const response=await service(async()=>Response.json(result))("catalog",request({page:0}));
  assert.equal(response.status,200);assert.deepEqual(await response.json(),result);
  for(const page of [-1,16,true,0.5,"0",null])assert.throws(()=>parseGroupCommand("catalog",{page},owner));
  for(const changed of [{...result,principal:other},{...result,nextPage:2},{...result,at:90},
    {...result,groups:[entry,entry]},{...result,groups:Array(5).fill(entry)},
    {...result,groups:[{...entry,owned:false}]},{...result,groups:[{...entry,owner:other}]},
    {...result,groups:[{...entry,invited:1}]},{...result,groups:[{...entry,active:1}]},
    {...result,groups:[{...entry,extra:1}]}]){
    assert.throws(()=>parseGroupCommandResult("catalog",changed,{page:0},100,owner));
  }
  assert.throws(()=>parseGroupCommandResult("catalog",{...result,groups:[{...entry,owned:false}]},{page:0},100,other));
  assert.deepEqual(parseGroupCommandResult("catalog",{...result,groups:[],nextPage:null},{page:15},100,owner).groups,[]);
});

test("group wrap transport preserves scoped ciphertext and refuses expired replies",async()=>{
  const metadata={reader:owner,readerEpub:other,epoch:1,revisionId:groupManifest.revisionId,digest:"f".repeat(64)};
  const body={...scope,at:100,fence,metadata,payload:btoa("opaque")};
  const read={payload:body.payload,predicate:scope.predicate,set_id:scope.set,epoch:1,revision_id:groupManifest.revisionId,
    reader_epub:other,key_commitment:groupManifest.keyCommitment,expires_at:102};
  const wraps:readonly [GroupCommandAction,Record<string,unknown>,unknown][]=[
    ["wrap-view",scope,{at:100,fence,snapshot:groupSnapshot,manifest:groupManifest}],
    ["wrap-publish",body,{digest:metadata.digest}],["wrap-read",scope,read],
  ];
  for(const [action,input,output] of wraps){
    const handle=service(async(url,init)=>{
      assert.equal(String(url),config.origin+"/api/v1/acl/sociacl/media/groups/"+action);
      assert.deepEqual(JSON.parse(String(init?.body)),input);
      assert.equal(new Headers(init?.headers).get("x-api-key"),"private-key");
      return Response.json(output);
    });
    const response=await handle(action,request(input));
    assert.equal(response.status,200);assert.deepEqual(await response.json(),output);
  }
  assert.equal((await service(async()=>Response.json({...read,expires_at:100}))("wrap-read",request(scope))).status,503);
});


test("current item authority transports the full 64-member projection and bounds larger responses",async()=>{
  const {p256}=await import("@noble/curves/nist.js");
  const principals=Array.from({length:64},(_,index)=>{
    const scalar=new Uint8Array(32);scalar[31]=index+1;
    const point=p256.getPublicKey(scalar,false);
    return Buffer.from(point.slice(1,33)).toString("base64url")+"."+Buffer.from(point.slice(33)).toString("base64url");
  }).sort();
  const edge={predicate:scope.predicate,setId:scope.set,stated:1,hamState:1};
  const projection={object,...scope,members:principals.filter(p=>p!==owner),
    snapshot:{objectSet:edge,members:principals.map(accessor=>({...edge,accessor}))}};
  const result={at:100,fence,objectVersion:1,projection,ownerPub:owner};
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length>18432);
  const response=await service(async()=>Response.json(result))("item-authority-view",request({object}));
  assert.equal(response.status,200);assert.deepEqual(await response.json(),result);
  const oversized=await service(async()=>new Response(" ".repeat(73729),{headers:{"content-type":"application/json"}}))(
    "item-authority-view",request({object}));
  assert.equal(oversized.status,503);
});
