// Cryptographic and HTTP contracts run only in CI.
import test from "node:test";
import assert from "node:assert/strict";
import {wrapItemDekToReaders} from "sociacl-ids";
import {wrapGroupKeyToMembers} from "sociacl-ids/group-reader-wrap";
import {createItemWrapClient,parseItemWrapBundle} from "./media-group-item-wrap-client";
import {shareDigest} from "./media-share-journal";
import {owner,reader,object,scope} from "./media-group-item-epoch-fixture";
const epub="EMvdmXTv89JPyMx5n3blU3L_D70U-6JoVaVzTvSzgYg.B_b0CP3o9X3I7tWrxA_F1VhXpjeMuIJCtQWnOh7LN5c";
const epriv="6EXhKuFCyTddo7uvYddNjXON5iKEMV7v8bCol7XOHt8";
const pair={pub:owner,priv:'unused',epub,epriv},target={object,...scope,reader},dek=new Uint8Array(32).fill(9),groupKey=new Uint8Array(32).fill(7);
const encode=(v:unknown)=>btoa(JSON.stringify(v));
async function fixture(){
  const metadata={itemEpoch:2,itemRevisionId:'a'.repeat(64),itemDigest:'b'.repeat(64),groupEpoch:3,groupRevisionId:'c'.repeat(64),groupKeyCommitment:await shareDigest(groupKey)};
  const recipients=[{account:owner,pub:owner,identityPub:owner,epub}];
  const own=await wrapItemDekToReaders(dek,{object,epoch:2,revisionId:metadata.itemRevisionId},recipients,[owner]);assert.ok(own.ok);
  const group=await wrapGroupKeyToMembers(groupKey,{group:scope.set,epoch:3,revisionId:metadata.groupRevisionId},recipients,[owner]);assert.ok(group.ok);
  const view={at:100,fence:'d'.repeat(64),ownerPub:owner,metadata},material={wrap:own.value[0],reference:{sha256:metadata.itemDigest,length:100}};
  const ownerRead={payload:encode(material),object,predicate:scope.predicate,set_id:scope.set,epoch:2,revision_id:metadata.itemRevisionId,reader_epub:epub,
    key_commitment:await shareDigest(dek),item_digest:metadata.itemDigest,expires_at:102};
  const groupRead={payload:encode(group.value[0]),predicate:scope.predicate,set_id:scope.set,epoch:3,revision_id:metadata.groupRevisionId,reader_epub:epub,
    key_commitment:metadata.groupKeyCommitment,expires_at:102};
  const writes:Record<string,unknown>[]=[];
  const fetcher:typeof fetch=async(url,init)=>{
    if(String(url).endsWith('/item-wrap-view'))return Response.json(view);
    if(String(url).endsWith('/item-owner-wrap-read'))return Response.json(ownerRead);
    if(String(url).endsWith('/wrap-read'))return Response.json(groupRead);
    const body=JSON.parse(String(init?.body));writes.push(body);return Response.json({digest:body.metadata.digest});
  };
  return {metadata,view,material,ownerRead,groupRead,writes,fetcher,client:createItemWrapClient(owner,fetcher,()=>100)};
}
test("owner prepares without writing and publication reuses saved exact opaque bytes",async()=>{
  const f=await fixture(),bundle=await f.client.prepare(target,pair);assert.equal(f.writes.length,0);
  await f.client.publish(bundle);f.view.fence='e'.repeat(64);await f.client.publish(bundle);
  assert.equal(f.writes.length,2);assert.equal(f.writes[0].payload,f.writes[1].payload);assert.deepEqual(f.writes[0].metadata,f.writes[1].metadata);
  assert.notEqual(f.writes[0].fence,f.writes[1].fence);assert.deepEqual(dek,new Uint8Array(32).fill(9));
  f.view.metadata={...f.metadata,itemEpoch:3};await assert.rejects(f.client.publish(bundle));assert.equal(f.writes.length,2);
});
test("preparation rejects mismatched owner keys and current item/group authority",async()=>{
  for(const patch of [{reader_epub:owner},{epoch:3},{revision_id:'f'.repeat(64)},{item_digest:'f'.repeat(64)},{key_commitment:'f'.repeat(64)},
    {payload:encode({})},{payload:encode({wrap:{},reference:{sha256:'b'.repeat(64),length:100}})}]){
    const f=await fixture();Object.assign(f.ownerRead,patch);await assert.rejects(f.client.prepare(target,pair));assert.equal(f.writes.length,0);
  }
  for(const patch of [{groupEpoch:4},{groupRevisionId:'f'.repeat(64)},{groupKeyCommitment:'f'.repeat(64)}]){
    const f=await fixture();Object.assign(f.view.metadata,patch);await assert.rejects(f.client.prepare(target,pair));
  }
  const f=await fixture();await assert.rejects(f.client.prepare(target,{...pair,pub:reader}));
  await assert.rejects(createItemWrapClient(owner,async()=>new Response(null,{status:503}),()=>100).prepare(target,pair));
  const controller=new AbortController();controller.abort();await assert.rejects(f.client.prepare(target,pair,controller.signal));
});
test("saved opaque bundles reject corruption, context changes and unsafe references",async()=>{
  const f=await fixture(),bundle=await f.client.prepare(target,pair);
  for(const value of [null,{...bundle,extra:1},{...bundle,version:2},{...bundle,payload:encode({})},{...bundle,reader:'bad'},
    {...bundle,ownerPub:'bad'},{...bundle,metadata:{...bundle.metadata,digest:'0'.repeat(64)}}])await assert.rejects(parseItemWrapBundle(value,owner));
  const original=JSON.parse(atob(bundle.payload));
  for(const value of [{...original,reference:{sha256:'f'.repeat(64),length:100}},{...original,reference:{sha256:'b'.repeat(64),length:0}},
    {...original,wrap:{...original.wrap,epoch:3}},{...original,wrap:{...original.wrap,wrappedKey:'bad'}},{...original,wrap:{}}]){
    const payload=encode(value),digest=await shareDigest(Uint8Array.from(atob(payload),c=>c.charCodeAt(0)));
    await assert.rejects(parseItemWrapBundle({...bundle,payload,metadata:{...bundle.metadata,digest}},owner));
  }
});
test("authority changes during crypto and delayed owner material fail before publication",async()=>{
  const f=await fixture();let views=0;
  const fetcher:typeof fetch=async(url,init)=>{
    if(String(url).endsWith('/item-wrap-view')&&++views===2)return Response.json({...f.view,metadata:{...f.metadata,itemEpoch:3}});
    return f.fetcher(url,init);
  };
  await assert.rejects(createItemWrapClient(owner,fetcher,()=>100).prepare(target,pair));assert.equal(f.writes.length,0);
  const g=await fixture();let now=100;
  const delayed:typeof fetch=async(url,init)=>{const response=await g.fetcher(url,init);if(String(url).endsWith('/wrap-read'))now=102;return response;};
  await assert.rejects(createItemWrapClient(owner,delayed,()=>now).prepare(target,pair));
});

test("retirement requires fresh owner authority and a forward epoch without publishing",async()=>{
 const f=await fixture(),bundle=await f.client.prepare(target,pair),original={...f.metadata};
 for(const patch of [{},{groupKeyCommitment:'f'.repeat(64)},{itemEpoch:1,groupEpoch:4},{itemEpoch:3,groupEpoch:2}]){
  f.view.metadata={...original,...patch};await assert.rejects(f.client.confirmObsolete(bundle));
 }
 f.view.metadata={...original,groupEpoch:4};f.view.ownerPub=reader;await assert.rejects(f.client.confirmObsolete(bundle));
 f.view.ownerPub=owner;f.view.at=90;await assert.rejects(f.client.confirmObsolete(bundle));f.view.at=100;
 await assert.rejects(createItemWrapClient(owner,async()=>new Response(null,{status:403}),()=>100).confirmObsolete(bundle));
 await assert.rejects(f.client.confirmObsolete(bundle,AbortSignal.abort()));
 assert.deepEqual(await f.client.confirmObsolete(bundle),{obsolete:true});
 f.view.metadata={...original,itemEpoch:3};assert.deepEqual(await f.client.confirmObsolete(bundle),{obsolete:true});
 assert.equal(f.writes.length,0);
});
