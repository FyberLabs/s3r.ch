// Encryption, signatures, IndexedDB and HTTP contracts execute in CI only.
import test from "node:test";
import assert from "node:assert/strict";
import {IDBFactory} from "fake-indexeddb";
import {createShareJournal,decryptShareJournal,encryptShareJournal} from "./media-share-journal";
import {createGroupKeyClient} from "./media-group-key-client";
import {applyGroupKey,pendingGroupKey,discardGroupKey} from "./media-group-key-recovery";
const owner="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const pair={pub:owner,priv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",epub:"EMvdmXTv89JPyMx5n3blU3L_D70U-6JoVaVzTvSzgYg.B_b0CP3o9X3I7tWrxA_F1VhXpjeMuIJCtQWnOh7LN5c",epriv:"6EXhKuFCyTddo7uvYddNjXON5iKEMV7v8bCol7XOHt8"};
const set="set_p_6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5_11111111111111111111111111111111";
const tenant="11111111-1111-4111-8111-111111111111",scope={predicate:"same-group" as const,set},signal=new AbortController().signal;
const scalar=new Uint8Array(32);scalar[31]=1;
const secret=new Uint8Array(32);secret[31]=9;
function fixture(){
 const journal=createShareJournal(new IDBFactory(),"group-key");let now=100,applied=false,mode="ok",writes=0;
 const fetcher:typeof fetch=async(url,init)=>{
  const action=String(url).split("/").at(-1);
  assert.ok(!String(init?.body).includes(pair.priv));assert.ok(!String(init?.body).includes(pair.epriv));
  if(mode==="offline")return new Response(null,{status:503});
  if(action==="key-view")return Response.json({at:now,fence:"a".repeat(64),previousEpoch:0,previousFinalizationId:"",
   snapshot:{predicate:scope.predicate,setId:set,setOwner:owner,ownerSigningPub:owner,ownerEncryptionPub:pair.epub,ownerIdentityHead:0,members:[]},
   config:{owner,setId:set,predicate:scope.predicate,settleWindowMs:3600000,configRevision:0,signature:"1".repeat(128)}});
  if(action==="key-state")return Response.json({at:now,state:applied?"applied":"absent",fence:"a".repeat(64)});
  const entry=(await journal.read(signal))!;assert.ok(entry);
  const draft=await decryptShareJournal(entry,tenant,pair,"group-key") as {attemptAt:number;groupKey:number[]};
  assert.ok(draft.attemptAt>=now);assert.deepEqual(draft.groupKey,Array.from(secret));draft.groupKey.fill(0);writes++;
  if(mode!=="uncommitted")applied=true;
  if(mode!=="ok")throw Error("lost reply");return Response.json({accepted:true});
 };
 const input={tenant,principal:owner,pair,fetcher,signal,journal,clock:()=>now};
 return {input,prepare:()=>createGroupKeyClient(owner,fetcher,input.clock).prepare(scope,"device",secret,scalar),
  mode:(value:string)=>{mode=value;},time:(value:number)=>{now=value;},reset:()=>{applied=false;},writes:()=>writes};
}
test("lost reply retains encrypted secret, and exact recovery keeps it after admission",async()=>{
 const f=fixture(),command=await f.prepare();assert.equal(await pendingGroupKey(f.input),null);
 f.mode("lost");await assert.rejects(applyGroupKey({...f.input,command,groupKey:secret}));
 const expected=(await pendingGroupKey(f.input))!,entry=(await f.input.journal.read(signal))!;
 assert.equal(expected.phase,"prepared");assert.equal(entry.object,set);
 await assert.rejects(decryptShareJournal(entry,tenant,pair,"group-command"));
 await assert.rejects(applyGroupKey({...f.input,expected:{...expected,token:"bad"}}));
 f.mode("ok");const admitted=await applyGroupKey({...f.input,expected});
 assert.equal(admitted.phase,"admitted");assert.equal(f.writes(),1);assert.ok(await f.input.journal.read(signal));
 assert.deepEqual(await pendingGroupKey(f.input),admitted);
 assert.deepEqual(await applyGroupKey({...f.input,expected:admitted}),admitted);
 await assert.rejects(discardGroupKey({...f.input,expected:admitted}));
 f.reset();await assert.rejects(applyGroupKey({...f.input,expected:admitted}));assert.equal(f.writes(),1);
 assert.equal(secret[31],9);assert.equal(scalar[31],1);
});
test("discard requires absence and expiration of every attempted fence",async()=>{
 const f=fixture(),command=await f.prepare();f.mode("uncommitted");
 await assert.rejects(applyGroupKey({...f.input,command,groupKey:secret}));
 const expected=(await pendingGroupKey(f.input))!;
 await assert.rejects(discardGroupKey({...f.input,expected}));f.time(104);await assert.rejects(discardGroupKey({...f.input,expected}));
 f.time(105);await discardGroupKey({...f.input,expected});assert.equal(await pendingGroupKey(f.input),null);
 await assert.rejects(discardGroupKey({...f.input,expected}));
 const g=fixture(),prepared=await g.prepare();g.mode("offline");
 await assert.rejects(applyGroupKey({...g.input,command:prepared,groupKey:secret}));g.mode("ok");
 await discardGroupKey({...g.input,expected:(await pendingGroupKey(g.input))!});assert.equal(await pendingGroupKey(g.input),null);
});
test("pending key cannot be replaced, and malformed or mismatched secrets refuse",async()=>{
 const f=fixture(),command=await f.prepare();
 for(const groupKey of [new Uint8Array(31),new Uint8Array(32),null])
  await assert.rejects(applyGroupKey({...f.input,command,groupKey:groupKey as Uint8Array}));
 await assert.rejects(applyGroupKey(f.input));assert.equal(await pendingGroupKey(f.input),null);
 f.mode("offline");await assert.rejects(applyGroupKey({...f.input,command,groupKey:secret}));
 await assert.rejects(applyGroupKey({...f.input,command,groupKey:secret}));
 const held=(await f.input.journal.read(signal))!;
 const draft=await decryptShareJournal(held,tenant,pair,"group-key") as any;
 const alteredCommand=structuredClone(draft.command);alteredCommand.command.document.manifest.signature="0".repeat(128);
 const alteredFinal=structuredClone(draft.command);alteredFinal.command.finalization.signature="0".repeat(128);
 for(const patch of [{...draft,tenant:"other"},{...draft,pub:"bad"},{...draft,attemptAt:true},{...draft,phase:"lost"},{...draft,groupKey:Array(32).fill(256)},
  {...draft,command:alteredCommand},{...draft,command:alteredFinal},{...draft,extra:1}]){
  const journal=createShareJournal(new IDBFactory(),"group-key"),sealed=await encryptShareJournal(patch,tenant,set,pair,"group-key");
  await journal.write({...sealed,tenant,object:set},null,signal);
  await assert.rejects(pendingGroupKey({...f.input,journal}));
 }
 draft.groupKey.fill(0);
});

test("retry cannot forget a later outstanding fence",async()=>{
 const f=fixture(),command=await f.prepare();f.mode("uncommitted");
 await assert.rejects(applyGroupKey({...f.input,command,groupKey:secret}));
 f.time(99);await assert.rejects(applyGroupKey({...f.input,expected:(await pendingGroupKey(f.input))!}));
 const expected=(await pendingGroupKey(f.input))!;
 f.time(104);await assert.rejects(discardGroupKey({...f.input,expected}));
 f.time(105);await discardGroupKey({...f.input,expected});
 assert.equal(await pendingGroupKey(f.input),null);
});
test("ciphertext CAS rejects writes and deletes after revision reuse",async()=>{
 const f=fixture(),command=await f.prepare();f.mode("uncommitted");
 await assert.rejects(applyGroupKey({...f.input,command,groupKey:secret}));
 const old=(await f.input.journal.read(signal))!;
 await f.input.journal.remove(old,signal);
 const first=await f.input.journal.write({...old,sha256:"a".repeat(64)},null,signal);
 const replacement=await f.input.journal.write({...old,sha256:"b".repeat(64)},first,signal);
 assert.equal(replacement.revision,old.revision);
 await assert.rejects(f.input.journal.remove(old,signal));
 await assert.rejects(f.input.journal.write(old,old,signal));
 assert.deepEqual(await f.input.journal.read(signal),replacement);
});

test("group wrap recovery persists exact ciphertext before writes and retains secret until remote opening",async()=>{
 const {deliverGroupKey,finishGroupKeyDelivery}=await import('./media-group-key-recovery');
 const journal=createShareJournal(new IDBFactory(),"group-key");let command:any,applied=false,lose=true,readable=false;
 const publications:string[]=[];
 const snapshot={predicate:scope.predicate,setId:set,setOwner:owner,ownerSigningPub:owner,ownerEncryptionPub:pair.epub,ownerIdentityHead:0,
  members:[{accessor:owner,stated:1,hamState:1,signingPub:owner,encryptionPub:pair.epub,identityHead:0}]};
 const fetcher:typeof fetch=async(url,init)=>{
  const action=String(url).split('/').at(-1),body=JSON.parse(String(init?.body));
  if(action==='key-view')return Response.json({at:100,fence:'a'.repeat(64),previousEpoch:0,previousFinalizationId:'',snapshot,
   config:{owner,setId:set,predicate:scope.predicate,settleWindowMs:3600000,configRevision:0,signature:'1'.repeat(128)}});
  if(action==='key-state')return Response.json({at:100,state:applied?'applied':'absent',fence:'a'.repeat(64)});
  if(action==='key-append'){command=body.command;applied=true;return Response.json({accepted:true});}
  if(action==='wrap-view')return Response.json({at:100,fence:'b'.repeat(64),snapshot,manifest:command.document.manifest});
  if(action==='wrap-publish'){
   const entry=(await journal.read(signal))!;
   const saved=await decryptShareJournal(entry,tenant,pair,'group-key') as any;
   assert.equal(saved.wraps.wraps[0].payload,body.payload);assert.equal(saved.next,0);saved.groupKey.fill(0);
   publications.push(body.payload);
   if(lose){lose=false;throw Error('lost publication response');}
   return Response.json({digest:body.metadata.digest});
  }
  if(!readable)return new Response(null,{status:403});
  return Response.json({payload:publications[0],predicate:scope.predicate,set_id:set,epoch:1,revision_id:command.document.manifest.revisionId,
   reader_epub:pair.epub,key_commitment:command.document.manifest.keyCommitment,expires_at:102});
 };
 const input={tenant,principal:owner,pair,fetcher,signal,journal,clock:()=>100};
 const signed=await createGroupKeyClient(owner,fetcher,input.clock).prepare(scope,'device',secret,scalar);
 const admitted=await applyGroupKey({...input,command:signed,groupKey:secret});
 await assert.rejects(deliverGroupKey({...input,expected:admitted}));
 const retry=(await pendingGroupKey(input))!;assert.equal(retry.published,0);assert.equal(retry.total,1);
 await assert.rejects(deliverGroupKey({...input,expected:admitted}));
 const published=await deliverGroupKey({...input,expected:retry});
 assert.equal(published.published,1);assert.equal(publications.length,2);assert.equal(publications[0],publications[1]);
 await assert.rejects(finishGroupKeyDelivery({...input,expected:published}));assert.ok(await journal.read(signal));
 readable=true;await finishGroupKeyDelivery({...input,expected:published});assert.equal(await journal.read(signal),null);
 await assert.rejects(deliverGroupKey({...input,expected:published}));
 await assert.rejects(finishGroupKeyDelivery({...input,expected:published}));
});
