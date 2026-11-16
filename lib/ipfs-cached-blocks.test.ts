import {test} from "node:test";
import assert from "node:assert/strict";
import {IDBFactory} from "fake-indexeddb";
import {createCachedMediaBlocks} from "./ipfs-cached-blocks";
import {createLocalCiphertextCache} from "./ipfs-local-cache";
import {rawMediaBlockCid} from "./ipfs-media-blocks";
const bytes=new Uint8Array([1,2,3]);
function fixture(enabled=true){
  let allowed=true,online=true,now=1000,gets=0;
  const abort=new AbortController(),factory=new IDBFactory();
  const cache=createLocalCiphertextCache({scope:'a'.repeat(64),policy:{enabled,maxBytes:3,maxEntries:1,ttlMs:1000},current:()=>allowed,factory,now:()=>now});
  const provider={async put(block:Uint8Array){return rawMediaBlockCid(block);},async get(){gets++;if(!online)throw Error('offline');return new Uint8Array(bytes);}};
  const client=createCachedMediaBlocks({provider,cache,current:()=>allowed,signal:abort.signal});
  return {cache,provider,client,factory,abort,revoke:()=>{allowed=false;},offline:()=>{online=false;},time:(value:number)=>{now=value;},gets:()=>gets};
}
test("verified direct retrieval populates optional cache and permits offline reuse until expiry",async()=>{
  const f=fixture(),cid=await rawMediaBlockCid(bytes);
  try{
    assert.deepEqual(await f.client.get(cid,3),bytes);assert.equal(f.gets(),1);
    f.offline();assert.deepEqual(await f.client.get(cid,3),bytes);assert.equal(f.gets(),1);
    f.time(2000);await assert.rejects(f.client.get(cid,3));assert.equal(f.gets(),2);
  }finally{f.cache.close();}
});
test("disabled retention never opens IndexedDB and does not imply offline availability",async()=>{
  const f=fixture(false),cid=await rawMediaBlockCid(bytes);
  assert.deepEqual(await f.client.get(cid,3),bytes);assert.deepEqual(await f.factory.databases(),[]);
  f.offline();await assert.rejects(f.client.get(cid,3));f.cache.close();
});
test("revocation and abort refuse cached data without contacting provider",async()=>{
  for(const action of ['revoke','abort']){
    const f=fixture(),cid=await rawMediaBlockCid(bytes);await f.client.get(cid,3);
    if(action==='revoke')f.revoke();else f.abort.abort();
    await assert.rejects(f.client.get(cid,3));assert.equal(f.gets(),1);f.cache.close();
  }
});
test("untrusted provider bytes are neither cached nor returned; cache write failure is best-effort",async()=>{
  const f=fixture(),cid=await rawMediaBlockCid(bytes);
  f.provider.get=async()=>new Uint8Array([3,2,1]);await assert.rejects(f.client.get(cid,3));assert.equal(await f.cache.get(cid),null);
  f.provider.get=async()=>new Uint8Array(bytes);f.cache.close();assert.deepEqual(await f.client.get(cid,3),bytes);
});
test("cache completion cannot bypass a revoked grant or trigger provider fallback",async()=>{
  const f=fixture(),cid=await rawMediaBlockCid(bytes);
  let allowed=true;
  const cache={...f.cache,get:async()=>{allowed=false;return new Uint8Array(bytes);}};
  const client=createCachedMediaBlocks({provider:f.provider,cache,current:()=>allowed,signal:f.abort.signal});
  await assert.rejects(client.get(cid,3));assert.equal(f.gets(),0);f.cache.close();
});
test("two pending cached reads bound work and malformed requests send no traffic",async()=>{
  const cid=await rawMediaBlockCid(bytes),abort=new AbortController();let release!:(value:Uint8Array)=>void;
  const pending=new Promise<Uint8Array>(resolve=>{release=resolve;});let calls=0;
  const provider={async put(block:Uint8Array){return rawMediaBlockCid(block);},async get(){calls++;return pending;}};
  const client=createCachedMediaBlocks({provider,current:()=>true,signal:abort.signal});
  await assert.rejects(client.get('bad',3));await assert.rejects(client.get(cid,0));assert.equal(calls,0);
  const a=client.get(cid,3),b=client.get(cid,3);await assert.rejects(client.get(cid,3));release(bytes);await Promise.all([a,b]);assert.equal(calls,2);
});
