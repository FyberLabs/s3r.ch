// Protected consent and HTTP contracts execute in CI.
import test from "node:test";
import assert from "node:assert/strict";
import {parseMediaGroupConsent,readMediaGroupConsent} from "./media-group-consent";
import {createMediaWrapService} from "./media-wrap-service";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const member="fPJ7GI0DT36KUjgDBLUaw8CJaeJ38hs1pgtI_EdmmXg.B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const scope={predicate:"same-group" as const,set:object.replace("media_","set_")};
const value={at:100,fence:"a".repeat(64),consent:{memberPub:member,
 state:{...scope,member,setOwner:owner,memberAssent:null as null|{stated:number;hamState:number;cancels:string[]},setAssent:{stated:1,hamState:2,cancels:[] as string[]},cancels:[] as string[],stated:0},
 draft:{role:"member",...scope,member,setOwner:owner,hamState:3,issuedAt:100,cancels:[] as string[]}}};
const parse=(v:unknown)=>parseMediaGroupConsent(v,scope,member);
test("consent projection preserves separate assents and detaches the draft",()=>{
 const parsed=parse(value);assert.deepEqual(parsed,value);
 parsed.consent.draft.cancels.push("b".repeat(64));assert.deepEqual(value.consent.draft.cancels,[]);
 const live=structuredClone(value);live.consent.state.memberAssent={stated:1,hamState:4,cancels:[]};live.consent.state.stated=1;live.consent.draft.hamState=5;
 assert.equal(parse(live).consent.state.stated,1);
 live.consent.state.cancels=["b".repeat(64)];live.consent.state.setAssent.cancels=["b".repeat(64)];live.consent.draft.cancels=["b".repeat(64)];live.consent.state.stated=0;
 assert.equal(parse(live).consent.state.stated,0);
 live.consent.state.memberAssent.cancels=["b".repeat(64)];live.consent.state.stated=1;
 assert.equal(parse(live).consent.state.stated,1);
 live.consent.state.memberAssent.stated=0;live.consent.state.stated=0;assert.equal(parse(live).consent.state.stated,0);
});
test("consent projection refuses identity substitution, malformed ordering and hidden grants",()=>{
 for(const bad of [null,[],{}, {...value,extra:1},{...value,at:-1},{...value,fence:"bad"},
   {...value,consent:{}},{...value,consent:{...value.consent,memberPub:"bad"}}])assert.throws(()=>parse(bad));
 assert.throws(()=>parseMediaGroupConsent(value,scope,"bad"));
 for(const patch of [{member:owner},{setOwner:member},{set:"bad"},{predicate:"named-circle"},{stated:1},{extra:1},
   {setAssent:null},{setAssent:{stated:0,hamState:2,cancels:[]}},
   {setAssent:{stated:1,hamState:Number.MAX_SAFE_INTEGER,cancels:[]}},
   {memberAssent:{}},{memberAssent:{stated:2,hamState:1,cancels:[]}},
   {memberAssent:{stated:1,hamState:-1,cancels:[]}},
   {cancels:["b".repeat(64)]},{cancels:["bad"]},{cancels:null},{cancels:Array(65).fill("b".repeat(64))},
   {cancels:["b".repeat(64),"b".repeat(64)]}])assert.throws(()=>parse({...value,consent:{...value.consent,state:{...value.consent.state,...patch}}}));
 for(const patch of [{role:"set"},{member:owner},{setOwner:member},{predicate:"named-circle"},{set:"bad"},
   {hamState:4},{issuedAt:99},{stated:1},{cancels:["b".repeat(64)]}])
   assert.throws(()=>parse({...value,consent:{...value.consent,draft:{...value.consent.draft,...patch}}}));
});
test("browser request is bounded, scope-only and fresh",async()=>{
 const read=(fetcher:typeof fetch,signal?:AbortSignal)=>readMediaGroupConsent(object,scope,member,fetcher,signal,()=>100);
 assert.deepEqual(await read(async(url,init)=>{assert.equal(url,"/api/media/group-consent-view");assert.equal(init?.credentials,"same-origin");
   assert.deepEqual(JSON.parse(String(init?.body)),{object,...scope});return Response.json(value);}),value);
 for(const response of [new Response(null,{status:403}),new Response("bad"),Response.json({}),Response.json({...value,at:90,consent:{...value.consent,draft:{...value.consent.draft,issuedAt:90}}}),
   Response.json({...value,at:102,consent:{...value.consent,draft:{...value.consent.draft,issuedAt:102}}}),new Response(" ".repeat(32769),{headers:{"content-type":"application/json"}})])await assert.rejects(read(async()=>response));
 await assert.rejects(read(async()=>Response.json(value),AbortSignal.abort()));
 for(const args of [["bad",member],[object,"bad"]])await assert.rejects(readMediaGroupConsent(args[0],scope,args[1],async()=>{throw Error("must not fetch");}));
});
const config={origin:"https://acl.example",tenant:"01234567-89ab-cdef-0123-456789abcdef",readers:[{principal:member,apiKey:"fixed-reader-key"}]};
const request=(body:unknown)=>new Request("https://s3r.ch/api/media/group-consent-view",{method:"POST",headers:{origin:"https://s3r.ch","content-type":"application/json"},body:JSON.stringify(body)});
test("BFF pins the reader credential and refuses a changed session or stale response",async()=>{
 const service=createMediaWrapService(config,"https://s3r.ch",async()=>member,async(url,init)=>{
   assert.ok(String(url).endsWith("group-consent-view"));assert.equal(new Headers(init?.headers).get("X-Api-Key"),"fixed-reader-key");
   assert.deepEqual(JSON.parse(String(init?.body)),{object,...scope});return Response.json(value);
 },()=>100);
 const response=await service(request({object,...scope}),"group-consent-view");assert.equal(response.status,200);assert.deepEqual(await response.json(),value);
 for(const body of [{object,...scope,member:owner},{object,...scope,set:"bad"},{object,...scope,predicate:"direct"}])assert.equal((await service(request(body),"group-consent-view")).status,400);
 let count=0;const changed=createMediaWrapService(config,"https://s3r.ch",async()=>++count===1?member:owner,async()=>Response.json(value),()=>100);
 assert.equal((await changed(request({object,...scope}),"group-consent-view")).status,403);
 const stale=createMediaWrapService(config,"https://s3r.ch",async()=>member,async()=>Response.json(value),()=>106);
 assert.equal((await stale(request({object,...scope}),"group-consent-view")).status,403);
});
