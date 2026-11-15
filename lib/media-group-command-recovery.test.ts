// Encryption, IndexedDB and HTTP contracts run in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import {IDBFactory} from "fake-indexeddb";
import {createShareJournal,encryptShareJournal,decryptShareJournal} from "./media-share-journal";
import {createGroupCommandClient} from "./media-group-client";
import {applyGroupCommand,pendingGroupCommand,discardGroupCommand} from "./media-group-command-recovery";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const pair={pub:owner,priv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",epub:"EMvdmXTv89JPyMx5n3blU3L_D70U-6JoVaVzTvSzgYg.B_b0CP3o9X3I7tWrxA_F1VhXpjeMuIJCtQWnOh7LN5c",epriv:"6EXhKuFCyTddo7uvYddNjXON5iKEMV7v8bCol7XOHt8"};
const object="media_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const tenant="11111111-1111-4111-8111-111111111111",scope={predicate:"same-group" as const,set:object.replace("media_","set_")},signal=new AbortController().signal;
function fixture(){
 const journal=createShareJournal(new IDBFactory(),"group-command");let now=100,applied=false,mode="ok",writes=0;
 const fetcher:typeof fetch=async(url,init)=>{
  const action=String(url).split("/").at(-1)!,body=JSON.parse(String(init?.body));
  assert.ok(!String(init?.body).includes(pair.priv));assert.ok(!String(init?.body).includes(pair.epriv));
  if(mode==="offline")return new Response(null,{status:503});
  if(action==="create-view")return Response.json({at:now,fence:"a".repeat(64),context:{owner,ownerPub:owner,predicate:scope.predicate,setId:scope.set}});
  if(action==="member-view")return Response.json({at:now,fence:"a".repeat(64),signerPub:owner,draft:{...body,setOwner:owner,hamState:1,issuedAt:now,cancels:[]}});
  if(action.endsWith("state"))return Response.json({at:now,state:applied?"applied":"absent",...(action==="member-state"||!applied?{fence:"a".repeat(64)}:{})});
  const entry=(await journal.read(signal))!;assert.ok(entry);
  const draft=await decryptShareJournal(entry,tenant,pair,"group-command") as {attemptAt:number};
  assert.equal(draft.attemptAt,now);writes++;
  if(mode!=="uncommitted")applied=true;
  if(mode!=="ok")throw Error("lost response");return Response.json({accepted:true});
 };
 const input={tenant,principal:owner,pair,fetcher,signal,journal,clock:()=>now};
 const client=createGroupCommandClient(owner,fetcher,input.clock),key=new Uint8Array(32);key[31]=1;
 return {input,prepare:(kind:"create"|"member")=>kind==="create"?client.prepareCreate(object,scope,3600000,key):client.prepareMember(scope,owner,"member",1,key),
  mode:(value:string)=>{mode=value;},time:(value:number)=>{now=value;},writes:()=>writes};
}
test("save signatures and attempt time before write, then reconcile a lost response",async()=>{
 for(const kind of ["create","member"] as const){
  const f=fixture(),command=await f.prepare(kind);assert.equal(await pendingGroupCommand(f.input),null);
  f.mode("lost");await assert.rejects(applyGroupCommand({...f.input,command}));
  const expected=(await pendingGroupCommand(f.input))!,entry=(await f.input.journal.read(signal))!;
  assert.equal(entry.object,scope.set);await assert.rejects(decryptShareJournal(entry,tenant,pair,"group-consent"));
  await assert.rejects(applyGroupCommand({...f.input,expected:{...expected,token:"wrong"}}));
  await assert.rejects(applyGroupCommand({...f.input,command}));
  f.mode("ok");f.time(110);await applyGroupCommand({...f.input,expected});
  assert.equal(f.writes(),1);assert.equal(await f.input.journal.read(signal),null);
  await assert.rejects(applyGroupCommand({...f.input,expected}));
 }
});
test("an absent attempted command cannot be discarded while its fence may commit",async()=>{
 const f=fixture(),command=await f.prepare("create");f.mode("uncommitted");await assert.rejects(applyGroupCommand({...f.input,command}));
 const expected=(await pendingGroupCommand(f.input))!;
 await assert.rejects(discardGroupCommand({...f.input,expected}));
 f.time(105);f.mode("offline");await assert.rejects(discardGroupCommand({...f.input,expected}));assert.ok(await f.input.journal.read(signal));
 f.mode("ok");assert.deepEqual(await discardGroupCommand({...f.input,expected}),{applied:false});
 await assert.rejects(discardGroupCommand({...f.input,expected}));
});
test("applied and never-attempted commands clear only after exact source reconciliation",async()=>{
 for(const mode of ["lost","offline"]){
  const f=fixture(),command=await f.prepare("member");f.mode(mode);await assert.rejects(applyGroupCommand({...f.input,command}));
  const expected=(await pendingGroupCommand(f.input))!;f.mode("ok");
  assert.deepEqual(await discardGroupCommand({...f.input,expected}),{applied:mode==="lost"});
  assert.equal(await f.input.journal.read(signal),null);
 }
});
test("expired member signatures stay retained and are never replaced",async()=>{
 const f=fixture(),command=await f.prepare("member");f.mode("uncommitted");await assert.rejects(applyGroupCommand({...f.input,command}));
 const expected=(await pendingGroupCommand(f.input))!;f.time(105);f.mode("ok");
 await assert.rejects(applyGroupCommand({...f.input,expected}));assert.equal(f.writes(),1);assert.ok(await f.input.journal.read(signal));
 assert.deepEqual(await discardGroupCommand({...f.input,expected}),{applied:false});
});
test("saved identity and signatures are verified before persistence or replay",async()=>{
 const f=fixture(),command=await f.prepare("create");
 const bad={...command,body:{...command.body,config:{...(command.body.config as object),signature:"0".repeat(128)}}};
 await assert.rejects(applyGroupCommand({...f.input,command:bad}));assert.equal(await f.input.journal.read(signal),null);
 f.mode("lost");await assert.rejects(applyGroupCommand({...f.input,command}));
 const entry=(await f.input.journal.read(signal))!,draft=await decryptShareJournal(entry,tenant,pair,"group-command") as any;
 for(const patch of [null,{...draft,version:2},{...draft,pub:"other"},{...draft,epub:"other"},{...draft,attemptAt:-1},{...draft,command:bad}]){
  const journal=createShareJournal(new IDBFactory(),"group-command"),encrypted=await encryptShareJournal(patch,tenant,scope.set,pair,"group-command");
  await journal.write({...encrypted,tenant,object:scope.set},null,signal);
  await assert.rejects(pendingGroupCommand({...f.input,journal}));
 }
 await assert.rejects(pendingGroupCommand({...f.input,tenant:"22222222-2222-4222-8222-222222222222"}));
 await assert.rejects(pendingGroupCommand({...f.input,signal:AbortSignal.abort()}));
});
