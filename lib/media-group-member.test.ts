// Member signing, recovery and HTTP contracts run in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import {createMediaGroupMember,parseMemberGroupRow} from "./media-group-member";
import {parseMediaGroupConsent} from "./media-group-consent";
import {createMediaWrapService} from "./media-wrap-service";
import {parseForumAuthority} from "./identity/forum-authority-records";
import {verifyForumKeySignature} from "./identity/forum-key-signature";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const other="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const scope={predicate:"same-group" as const,set:object.replace("media_","set_")};
const scalar=()=>{const key=new Uint8Array(32);key[31]=1;return key;};
const view={at:100,fence:"a".repeat(64),consent:{memberPub:owner,
 state:{...scope,member:owner,setOwner:owner,memberAssent:null as null|{stated:number;hamState:number;cancels:string[]},setAssent:{stated:1,hamState:1,cancels:[]} as null|{stated:number;hamState:number;cancels:string[]},cancels:[] as string[],stated:0},
 draft:{role:"member",...scope,member:owner,setOwner:owner,hamState:2,issuedAt:100,cancels:[] as string[]}}};
const client=(fetcher:typeof fetch,clock=()=>100)=>createMediaGroupMember(fetcher,clock);
const signed=()=>client(async()=>Response.json(view)).prepare(object,scope,owner,1,scalar());
const state=(applied=false,at=100)=>({at,fence:view.fence,state:applied?"applied":"absent"});
test("member signing uses the protected key and a pre-await scalar copy",async()=>{
 const key=scalar();const row=await client(async()=>{key.fill(0);return Response.json(view);}).prepare(object,scope,owner,1,key);
 const parsed=parseForumAuthority("membership",row.record);assert.ok(parsed);assert.equal(verifyForumKeySignature(owner,row.record.sig,parsed.bytes),true);
 assert.equal(row.record.role,"member");assert.deepEqual(parseMemberGroupRow(row,scope,owner),row);
 const wrong=scalar();wrong[31]=2;await assert.rejects(client(async()=>Response.json(view)).prepare(object,scope,owner,1,wrong));
 for(const args of [[2,scalar()],[1,new Uint8Array(1)]] as const)await assert.rejects(client(async()=>{throw Error("must not fetch");}).prepare(object,scope,owner,args[0] as 1,args[1]));
 await assert.rejects(client(async()=>Response.json(view)).prepare(object,scope,owner,1,scalar(),AbortSignal.abort()));
 let now=100;await assert.rejects(client(async()=>{now=106;return Response.json(view);},()=>now).prepare(object,scope,owner,1,scalar()));
});
test("withdrawal needs own assent but no surviving invitation or cancellation acknowledgement",async()=>{
 const held=structuredClone(view);held.consent.state.memberAssent={stated:1,hamState:Number.MAX_SAFE_INTEGER,cancels:[]};
 held.consent.state.setAssent=null;held.consent.state.cancels=Array.from({length:65},(_,i)=>(i+1).toString(16).padStart(64,"0"));held.consent.draft.hamState=Number.MAX_SAFE_INTEGER;
 assert.equal(parseMediaGroupConsent(held,scope,owner,true).consent.draft.cancels.length,0);
 assert.throws(()=>parseMediaGroupConsent(held,scope,owner));
 const row=await client(async(url)=>{assert.ok(String(url).endsWith("group-withdrawal-view"));return Response.json(held);}).prepare(object,scope,owner,0,scalar());
 assert.equal(row.record.stated,0);assert.deepEqual(row.record.cancels,[]);assert.equal(row.record.hamState,Number.MAX_SAFE_INTEGER);
 held.consent.state.memberAssent.stated=0;assert.throws(()=>parseMediaGroupConsent(held,scope,owner,true));
 held.consent.state.memberAssent=null;assert.throws(()=>parseMediaGroupConsent(held,scope,owner,true));
});
test("exact retry recovery skips a committed row and never repeats a lost write blindly",async()=>{
 const row=await signed();let applied=false,writes=0;
 const service=client(async(url,init)=>{
  const body=JSON.parse(String(init?.body));assert.equal(init?.credentials,"same-origin");assert.deepEqual(body.row,row);
  if(String(url).endsWith("check"))return Response.json(state(applied));
  writes++;applied=true;assert.equal(body.at,100);assert.equal(body.fence,view.fence);throw Error("lost reply");
 });
 await assert.rejects(service.append(object,scope,owner,row));assert.equal(writes,1);
 await service.append(object,scope,owner,row);assert.equal(writes,1);
 assert.equal((await service.state(object,scope,owner,row)).state,"applied");
 let requests=0;await assert.rejects(client(async()=>{requests++;return Response.json(state(false,105));},()=>105).append(object,scope,owner,row));assert.equal(requests,1);
});
test("member transport refuses substituted rows and malformed or stale responses",async()=>{
 const row=await signed();
 for(const bad of [null,{}, {...row,kind:"object-set"},{...row,soul:"other"},{...row,extra:1},
  {...row,record:{...row.record,role:"set"}},{...row,record:{...row.record,member:other}},
  {...row,record:{...row.record,sig:""}},{...row,record:{...row.record,sig:"a".repeat(129)}},
  {...row,record:{...row.record,hamState:-1}},{...row,record:{...row.record,attest:"extra"}}])assert.throws(()=>parseMemberGroupRow(bad,scope,owner));
 for(const response of [new Response(null,{status:409}),new Response("bad"),Response.json({}),Response.json(state(false,90)),new Response(" ".repeat(4097),{headers:{"content-type":"application/json"}})])
  await assert.rejects(client(async()=>response).state(object,scope,owner,row));
 await assert.rejects(client(async()=>Response.json(state())).state("bad",scope,owner,row));
 await assert.rejects(client(async()=>Response.json(state())).append(object,scope,owner,row,AbortSignal.abort()));
 for(const reply of [{applied:false},{applied:true,extra:1},null])await assert.rejects(client(async(url)=>Response.json(String(url).endsWith("check")?state():reply)).append(object,scope,owner,row));
 await client(async(url)=>Response.json(String(url).endsWith("check")?state():{applied:true})).append(object,scope,owner,row);
});
const config={origin:"https://acl.example",tenant:"01234567-89ab-cdef-0123-456789abcdef",readers:[{principal:owner,apiKey:"fixed-reader-key"}]};
const request=(body:unknown)=>new Request("https://s3r.ch/api/media/group-consent-append",{method:"POST",headers:{origin:"https://s3r.ch","content-type":"application/json"},body:JSON.stringify(body)});
test("member BFF pins the signer and credential and rechecks session after writes",async()=>{
 const row=await signed(),body={object,...scope,row,at:100,fence:view.fence};
 const bff=createMediaWrapService(config,"https://s3r.ch",async()=>owner,async(url,init)=>{
  assert.equal(new Headers(init?.headers).get("X-Api-Key"),"fixed-reader-key");
  return Response.json(String(url).endsWith("check")?state():{applied:true});
 },()=>100);
 assert.equal((await bff(request(body),"group-consent-append")).status,200);
 assert.equal((await bff(request({object,...scope,row}),"group-consent-check")).status,200);
 for(const patch of [{member:other},{at:true},{fence:"bad"},{row:{...row,record:{...row.record,member:other}}}])assert.equal((await bff(request({...body,...patch}),"group-consent-append")).status,400);
 let calls=0;const changed=createMediaWrapService(config,"https://s3r.ch",async()=>++calls===1?owner:other,async()=>Response.json({applied:true}),()=>100);
 assert.equal((await changed(request(body),"group-consent-append")).status,403);
 for(const reply of [{applied:false},{applied:true,extra:1}])assert.equal((await createMediaWrapService(config,"https://s3r.ch",async()=>owner,async()=>Response.json(reply),()=>100)(request(body),"group-consent-append")).status,403);
});

test("withdrawal BFF accepts bounded cancellation history and checks the final session",async()=>{
 const held=structuredClone(view);held.consent.state.memberAssent={stated:1,hamState:2,cancels:[]};held.consent.state.setAssent=null;
 held.consent.state.cancels=Array.from({length:65},(_,i)=>(i+1).toString(16).padStart(64,"0"));held.consent.draft.hamState=2;
 const service=createMediaWrapService(config,"https://s3r.ch",async()=>owner,async()=>Response.json(held),()=>100);
 assert.equal((await service(request({object,...scope}),"group-withdrawal-view")).status,200);
 const stale=createMediaWrapService(config,"https://s3r.ch",async()=>owner,async()=>Response.json(state(false,90)),()=>100);
 assert.equal((await stale(request({object,...scope,row:await signed()}),"group-consent-check")).status,403);
});
