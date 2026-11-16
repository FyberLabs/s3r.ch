// Crypto and HTTP contracts run only in CI.
import test from "node:test";
import assert from "node:assert/strict";
import {wrapGroupKeyToMembers} from "sociacl-ids/group-reader-wrap";
import {wrapItemDekToGroupEpoch} from "sociacl-ids/group-wrap";
import {shareDigest} from "./media-share-journal";
import {openGroupItem} from "./media-group-item-reader";
import {reader,object,scope} from "./media-group-item-epoch-fixture";
const epub="EMvdmXTv89JPyMx5n3blU3L_D70U-6JoVaVzTvSzgYg.B_b0CP3o9X3I7tWrxA_F1VhXpjeMuIJCtQWnOh7LN5c";
const epriv="6EXhKuFCyTddo7uvYddNjXON5iKEMV7v8bCol7XOHt8",groupKey=new Uint8Array(32).fill(7),dek=new Uint8Array(32).fill(9);
const encode=(value:unknown)=>btoa(JSON.stringify(value));
async function fixture(){
  const wrappedGroup=await wrapGroupKeyToMembers(groupKey,{group:scope.set,epoch:3,revisionId:'c'.repeat(64)},
    [{account:reader,pub:reader,identityPub:reader,epub}],[reader]);assert.ok(wrappedGroup.ok);
  const wrappedItem=await wrapItemDekToGroupEpoch(dek,groupKey,{object,group:scope.set,epoch:2,revisionId:'a'.repeat(64)});assert.ok(wrappedItem.ok);
  const reference={sha256:'b'.repeat(64),length:100};
  const material={wrap:wrappedItem.value,reference};
  const key={payload:encode(wrappedGroup.value[0]),predicate:scope.predicate,set_id:scope.set,epoch:3,revision_id:'c'.repeat(64),reader_epub:epub,
    key_commitment:await shareDigest(groupKey),expires_at:102};
  const item={payload:encode(material),object,predicate:scope.predicate,set_id:scope.set,item_epoch:2,item_revision_id:'a'.repeat(64),item_digest:reference.sha256,
    group_epoch:3,group_revision_id:key.revision_id,group_key_commitment:key.key_commitment,expires_at:102};
  let reads=0;const input={principal:reader,object,scope,epriv,epub,clock:()=>100,signal:new AbortController().signal,
    fetcher:async(url:unknown,init?:RequestInit)=>{assert.equal(init?.credentials,'same-origin');assert.equal(init?.redirect,'error');
      if(String(url).endsWith('/item-wrap-read')){reads++;return Response.json(item);}return Response.json(key);}};
  return {input,key,item,material,reference,reads:()=>reads};
}
test("recipient opens only jointly authorized matching epochs and rechecks after crypto",async()=>{
  const f=await fixture(),opened=await openGroupItem(f.input);assert.deepEqual(opened.key,dek);assert.deepEqual(opened.reference,f.reference);
  assert.equal(opened.epoch,2);assert.equal(f.reads(),2);opened.key.fill(0);
});
test("group revision changes, bad item context and malformed reference are refused",async()=>{
  for(const patch of [{group_epoch:4},{group_revision_id:'f'.repeat(64)},{group_key_commitment:'f'.repeat(64)},
    {item_epoch:3},{item_revision_id:'f'.repeat(64)},{payload:encode({})},{payload:encode({wrap:{},reference:{sha256:'b'.repeat(64),length:100}})}]){
    const f=await fixture();Object.assign(f.item,patch);await assert.rejects(openGroupItem(f.input));
  }
  for(const reference of [{sha256:'c'.repeat(64),length:100},{sha256:'b'.repeat(64),length:1},{sha256:'b'.repeat(64),length:Number.MAX_SAFE_INTEGER},{sha256:'b'.repeat(64),length:true}]){
    const f=await fixture();f.item.payload=encode({...f.material,reference});await assert.rejects(openGroupItem(f.input));
  }
});
test("revocation and changed bytes after decryption never return the item key",async()=>{
  for(const changed of [()=>new Response(null,{status:403}),()=>Response.json({}),()=>new Response(null,{headers:{'content-type':'text/plain'}})]){
    const f=await fixture(),base=f.input.fetcher;
    f.input.fetcher=async(url,init)=>String(url).endsWith('/item-wrap-read')&&f.reads()===1?changed():base(url,init);
    await assert.rejects(openGroupItem(f.input));
  }
  const f=await fixture(),base=f.input.fetcher;
  f.input.fetcher=async(url,init)=>{if(String(url).endsWith('/item-wrap-read')&&f.reads()===1)return Response.json({...f.item,payload:encode({...f.material,reference:{...f.reference,length:101}})});return base(url,init);};
  await assert.rejects(openGroupItem(f.input));
  const controller=new AbortController();controller.abort();await assert.rejects(openGroupItem({...f.input,signal:controller.signal}));
});
test("expiry during item opening and oversized replies fail closed",async()=>{
  const f=await fixture(),base=f.input.fetcher;let now=100;
  f.input.clock=()=>now;f.input.fetcher=async(url,init)=>{const response=await base(url,init);if(f.reads()===1)now=102;return response;};
  await assert.rejects(openGroupItem(f.input));
  const g=await fixture();g.input.fetcher=async(url)=>String(url).endsWith('/item-wrap-read')?new Response(' '.repeat(92161),{headers:{'content-type':'application/json'}}):Response.json(g.key);
  await assert.rejects(openGroupItem(g.input));
});
