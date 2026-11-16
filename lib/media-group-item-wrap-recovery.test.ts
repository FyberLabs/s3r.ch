// Encrypted journal and HTTP contracts run only in CI. Opaque bytes are fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import {IDBFactory} from "fake-indexeddb";
import {applyItemWrap,pendingItemWrap,retireItemWrap} from "./media-group-item-wrap-recovery";
import {createShareJournal,shareDigest,decryptShareJournal,encryptShareJournal} from "./media-share-journal";
import {owner,reader,object,scope} from "./media-group-item-epoch-fixture";
import type {ItemWrapBundle} from "./media-group-item-wrap-client";
const pair={pub:owner,priv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE",epub:owner,epriv:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE"};
async function fixture(){
  const metadata={itemEpoch:2,itemRevisionId:'a'.repeat(64),itemDigest:'b'.repeat(64),groupEpoch:3,groupRevisionId:'c'.repeat(64),groupKeyCommitment:'d'.repeat(64)};
  const payload=btoa(JSON.stringify({wrap:{object,group:scope.set,epoch:2,revisionId:metadata.itemRevisionId,scope:'item-dek',target:'group-epoch',targetId:scope.set,wrappedKey:'00'.repeat(29)},reference:{sha256:metadata.itemDigest,length:100}}));
  const bundle:ItemWrapBundle={version:1,ownerPub:owner,object,...scope,reader,metadata:{...metadata,digest:await shareDigest(Uint8Array.from(atob(payload),c=>c.charCodeAt(0)))},payload};
  let lost=true,denied=false;const writes:unknown[]=[];
  const input={tenant:'11111111-1111-4111-8111-111111111111',principal:owner,pair,clock:()=>100,signal:new AbortController().signal,journal:createShareJournal(new IDBFactory(),'group-item-wrap'),
    fetcher:async(url:unknown,init?:RequestInit)=>{
      if(denied)return new Response(null,{status:403});
      if(String(url).endsWith('item-wrap-view'))return Response.json({at:100,fence:'e'.repeat(64),ownerPub:owner,metadata});
      const entry=await input.journal.read(input.signal);assert.ok(entry);
      const saved=await decryptShareJournal(entry,input.tenant,pair,'group-item-wrap') as {bundle:ItemWrapBundle};
      const body=JSON.parse(String(init?.body));assert.equal(body.payload,saved.bundle.payload);writes.push(body);
      if(lost)throw Error('lost response');return Response.json({digest:bundle.metadata.digest});
    }};
  return {input,bundle,metadata,writes,recover:()=>{lost=false;},deny:()=>{denied=true;}};
}
test("lost publication retains encrypted exact bytes until successful replay",async()=>{
  const f=await fixture();assert.equal(await pendingItemWrap(f.input),null);
  await assert.rejects(applyItemWrap({...f.input,bundle:f.bundle}));const expected=(await pendingItemWrap(f.input))!;
  assert.equal(expected.object,object);assert.equal(expected.reader,reader);
  const raw=await f.input.journal.read(f.input.signal);assert.ok(raw);assert.ok(!JSON.stringify(raw).includes(f.bundle.payload));
  await assert.rejects(applyItemWrap({...f.input,bundle:f.bundle}));await assert.rejects(applyItemWrap({...f.input,expected:{...expected,token:'bad'}}));
  await assert.rejects(applyItemWrap(f.input));f.recover();assert.deepEqual(await applyItemWrap({...f.input,expected}),{delivered:true});
  assert.deepEqual(f.writes[0],f.writes[1]);assert.equal(await pendingItemWrap(f.input),null);
  await assert.rejects(applyItemWrap(f.input));
});
test("authorization loss, identity mismatch and corrupt journal retain pending work",async()=>{
  const f=await fixture();await assert.rejects(applyItemWrap({...f.input,bundle:f.bundle}));const expected=(await pendingItemWrap(f.input))!;f.deny();
  await assert.rejects(applyItemWrap({...f.input,expected}));assert.deepEqual(await pendingItemWrap(f.input),expected);
  await assert.rejects(pendingItemWrap({...f.input,principal:reader}));
  const entry=(await f.input.journal.read(f.input.signal))!,draft=await decryptShareJournal(entry,f.input.tenant,pair,'group-item-wrap') as Record<string,unknown>;
  for(const patch of [{version:2},{pub:reader},{epub:reader},{tenant:'other'},{bundle:{...f.bundle,object:'bad'}},{bundle:{...f.bundle,ownerPub:reader}}]){
    const encrypted=await encryptShareJournal({...draft,...patch},f.input.tenant,object,pair,'group-item-wrap');
    const current=(await f.input.journal.read(f.input.signal))!;await f.input.journal.write({...encrypted,tenant:f.input.tenant,object},current,f.input.signal);
    await assert.rejects(pendingItemWrap(f.input));
  }
});
test("failed persistence and aborted sessions never reach publication",async()=>{
  const f=await fixture();
  await assert.rejects(applyItemWrap({...f.input,bundle:f.bundle,journal:{...f.input.journal,write:async()=>{throw Error('full');}}}));
  assert.equal(f.writes.length,0);
  const controller=new AbortController();controller.abort();await assert.rejects(applyItemWrap({...f.input,bundle:f.bundle,signal:controller.signal}));assert.equal(f.writes.length,0);
});

for(const field of ['groupEpoch','itemEpoch'] as const)test(`newer ${field} permits explicit local retirement of exact saved delivery`,async()=>{
 const f=await fixture();await assert.rejects(applyItemWrap({...f.input,bundle:f.bundle}));
 const expected=(await pendingItemWrap(f.input))!,saved=(await f.input.journal.read(f.input.signal))!;
 await assert.rejects(retireItemWrap({...f.input,expected}));assert.deepEqual(await f.input.journal.read(f.input.signal),saved);
 f.metadata[field]++;
 await assert.rejects(applyItemWrap({...f.input,expected}));assert.equal(f.writes.length,1);
 await assert.rejects(retireItemWrap({...f.input,expected:{...expected,token:'changed'}}));
 assert.deepEqual(await f.input.journal.read(f.input.signal),saved);
 assert.deepEqual(await retireItemWrap({...f.input,expected}),{retired:true});
 assert.equal(await f.input.journal.read(f.input.signal),null);assert.equal(f.writes.length,1);
 await assert.rejects(retireItemWrap({...f.input,expected}));
});
test("denial, cancellation and concurrent replacement retain the saved delivery",async()=>{
 const f=await fixture();await assert.rejects(applyItemWrap({...f.input,bundle:f.bundle}));
 const expected=(await pendingItemWrap(f.input))!,saved=(await f.input.journal.read(f.input.signal))!;f.metadata.groupEpoch++;
 await assert.rejects(retireItemWrap({...f.input,expected,fetcher:async()=>new Response(null,{status:403})}));
 await assert.rejects(retireItemWrap({...f.input,expected,signal:AbortSignal.abort()}));
 assert.deepEqual(await f.input.journal.read(f.input.signal),saved);
 const replaced=async(...args:Parameters<typeof f.input.fetcher>)=>{
  await f.input.journal.write(saved,saved,f.input.signal);return f.input.fetcher(...args);
 };
 await assert.rejects(retireItemWrap({...f.input,expected,fetcher:replaced}));
 const current=(await f.input.journal.read(f.input.signal))!;
 assert.equal(current.revision,saved.revision+1);assert.deepEqual(current.encrypted,saved.encrypted);assert.equal(f.writes.length,1);
});
