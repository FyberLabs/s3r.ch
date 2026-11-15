// Encryption, HTTP and IndexedDB contracts run in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import {IDBFactory} from "fake-indexeddb";
import {createShareJournal,encryptShareJournal,decryptShareJournal} from "./media-share-journal";
import {applyGroupConsent,pendingGroupConsent,discardGroupConsent} from "./media-group-recovery";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const pair={pub:owner,priv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",epub:"EMvdmXTv89JPyMx5n3blU3L_D70U-6JoVaVzTvSzgYg.B_b0CP3o9X3I7tWrxA_F1VhXpjeMuIJCtQWnOh7LN5c",epriv:"6EXhKuFCyTddo7uvYddNjXON5iKEMV7v8bCol7XOHt8"};
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const tenant="11111111-1111-4111-8111-111111111111",scope={predicate:"same-group" as const,set:object.replace("media_","set_")};
const target={object,scope,member:owner,stated:1 as const},signal=new AbortController().signal;
function fixture(){
 const journal=createShareJournal(new IDBFactory(),"group-consent");let now=100,applied=false,lost=false,unavailable=false,writes=0,views=0;
 const fetcher:typeof fetch=async(url,init)=>{
  if(unavailable)return new Response(null,{status:503});
  const body=JSON.parse(String(init?.body));assert.ok(!String(init?.body).includes(pair.priv));assert.ok(!String(init?.body).includes(pair.epriv));
  if(String(url).endsWith("view")){views++;return Response.json({at:now,fence:"a".repeat(64),consent:{memberPub:owner,state:{...scope,member:owner,setOwner:owner,memberAssent:null,setAssent:{stated:1,hamState:1,cancels:[]},cancels:[],stated:0},draft:{role:"member",...scope,member:owner,setOwner:owner,hamState:2,issuedAt:now,cancels:[]}}});}
  if(String(url).endsWith("check"))return Response.json({at:now,fence:"a".repeat(64),state:applied?"applied":"absent"});
  assert.ok(await journal.read(signal));assert.equal(body.row.record.member,owner);writes++;applied=true;
  if(lost)throw Error("lost reply");return Response.json({applied:true});
 };
 const input={tenant,pair,fetcher,signal,journal,clock:()=>now};
 return {input,journal,setNow:(v:number)=>{now=v;},setLost:()=>{lost=true;},setAbsent:()=>{applied=false;},setUnavailable:()=>{unavailable=true;},counts:()=>({writes,views})};
}
test("save before write and reconcile the exact encrypted row after a lost reply",async()=>{
 const f=fixture();assert.equal(await pendingGroupConsent(f.journal,tenant,pair,signal),null);
 f.setLost();await assert.rejects(applyGroupConsent({...f.input,target}));
 const held=(await pendingGroupConsent(f.journal,tenant,pair,signal))!;
 const entry=(await f.journal.read(signal))!;await assert.rejects(decryptShareJournal(entry,tenant,pair));
 await assert.rejects(applyGroupConsent({...f.input,target}));
 await assert.rejects(applyGroupConsent(f.input));
 await assert.rejects(applyGroupConsent({...f.input,expected:{...held,token:"wrong"}}));
 f.setNow(110);await applyGroupConsent({...f.input,expected:held});
 assert.deepEqual(f.counts(),{writes:1,views:1});assert.equal(await f.journal.read(signal),null);
 await assert.rejects(applyGroupConsent({...f.input,expected:held}));
});
test("expired absent drafts remain until explicit source-confirmed discard",async()=>{
 const f=fixture();f.setLost();await assert.rejects(applyGroupConsent({...f.input,target}));f.setAbsent();
 const expected=(await pendingGroupConsent(f.journal,tenant,pair,signal))!;
 await assert.rejects(discardGroupConsent({...f.input,expected}));
 f.setNow(105);await assert.rejects(applyGroupConsent({...f.input,expected}));
 assert.ok(await f.journal.read(signal));assert.deepEqual(f.counts(),{writes:1,views:1});
 assert.deepEqual(await discardGroupConsent({...f.input,expected}),{applied:false});
 assert.equal(await discardGroupConsent({...f.input,expected}),undefined);
});
test("applied discard clears recovery but source failure never discards",async()=>{
 const f=fixture();f.setLost();await assert.rejects(applyGroupConsent({...f.input,target}));
 const expected=(await pendingGroupConsent(f.journal,tenant,pair,signal))!;
 assert.deepEqual(await discardGroupConsent({...f.input,expected}),{applied:true});
 const g=fixture();g.setLost();await assert.rejects(applyGroupConsent({...g.input,target}));
 const pending=(await pendingGroupConsent(g.journal,tenant,pair,signal))!;g.setNow(106);g.setUnavailable();
 await assert.rejects(discardGroupConsent({...g.input,expected:pending}));assert.ok(await g.journal.read(signal));
});
test("successful consent removes its draft and invalid scalar never publishes",async()=>{
 const f=fixture();assert.deepEqual(await applyGroupConsent({...f.input,target}),{object,stated:1});assert.equal(await f.journal.read(signal),null);
 for(const priv of ["bad",pair.priv.slice(0,-1)+"F"]){
  await assert.rejects(applyGroupConsent({...f.input,pair:{...pair,priv},target}));assert.equal(await f.journal.read(signal),null);
 }
 await assert.rejects(applyGroupConsent({...f.input,signal:AbortSignal.abort(),target}));
});
test("encrypted drafts still require identity and signed content checks",async()=>{
 const f=fixture();f.setLost();await assert.rejects(applyGroupConsent({...f.input,target}));
 const entry=(await f.journal.read(signal))!,draft=await decryptShareJournal(entry,tenant,pair,"group-consent") as any;
 for(const value of [null,{...draft,version:2},{...draft,memberPub:"other"},{...draft,epub:"other"},{...draft,row:{...draft.row,record:{...draft.row.record,hamState:3}}}]){
  const journal=createShareJournal(new IDBFactory(),"group-consent");const sealed=await encryptShareJournal(value,tenant,object,pair,"group-consent");
  await journal.write({...sealed,tenant,object},null,signal);await assert.rejects(pendingGroupConsent(journal,tenant,pair,signal));
 }
 const factory=new IDBFactory(),regular=createShareJournal(factory),group=createShareJournal(factory,"group-consent");
 await regular.write({...entry},null,signal);assert.equal(await group.read(signal),null);
 assert.throws(()=>createShareJournal(factory,"invalid" as any));
});
