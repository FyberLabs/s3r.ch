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

test("explicit cache-only reads refuse absent, evicted and expired data without provider traffic",async()=>{
  const f=fixture(),cid=await rawMediaBlockCid(bytes);
  const client=createCachedMediaBlocks({provider:f.provider,cache:f.cache,current:()=>true,signal:f.abort.signal,readPolicy:'cache-only'});
  await assert.rejects(client.get(cid,3));assert.equal(f.gets(),0);
  await f.cache.put(cid,bytes);assert.deepEqual(await client.get(cid,3),bytes);
  await f.cache.evict([cid]);await assert.rejects(client.get(cid,3));
  await f.cache.put(cid,bytes);f.time(2000);await assert.rejects(client.get(cid,3));
  assert.equal(f.gets(),0);f.cache.close();
});
test("cache-only storage errors and corrupt or wrong-size entries never fall back",async()=>{
  const f=fixture(),cid=await rawMediaBlockCid(bytes);
  for(const get of [async()=>{throw Error('storage denied');},async()=>new Uint8Array([3,2,1]),async()=>new Uint8Array([1])]){
    const client=createCachedMediaBlocks({provider:f.provider,cache:{...f.cache,get},current:()=>true,signal:f.abort.signal,readPolicy:'cache-only'});
    await assert.rejects(client.get(cid,3));
  }
  const absent=createCachedMediaBlocks({provider:f.provider,current:()=>true,signal:f.abort.signal,readPolicy:'cache-only'});
  await assert.rejects(absent.get(cid,3));assert.equal(f.gets(),0);f.cache.close();
});
test("read policy is validated and captured, while explicit uploads retain their own provider path",async()=>{
  const f=fixture(),cid=await rawMediaBlockCid(bytes);
  const options={provider:f.provider,cache:f.cache,current:()=>true,signal:f.abort.signal,readPolicy:'cache-only' as 'cache-only'|'provider-allowed'};
  const client=createCachedMediaBlocks(options);options.readPolicy='provider-allowed';
  await assert.rejects(client.get(cid,3));assert.equal(f.gets(),0);
  assert.equal(await client.put(bytes),cid);
  assert.throws(()=>createCachedMediaBlocks({...options,readPolicy:'invalid' as 'cache-only'}));f.cache.close();
});

test("acknowledged uploads populate optional cache without a provider download",async()=>{
  const f=fixture(),cid=await rawMediaBlockCid(bytes);assert.equal(await f.client.put(bytes),cid);f.offline();
  assert.deepEqual(await f.client.get(cid,3),bytes);assert.equal(f.gets(),0);f.cache.close();
});
test("failed or false upload acknowledgements do not populate cache",async()=>{
  for(const fail of [true,false]){
    const f=fixture(),cid=await rawMediaBlockCid(bytes);
    f.provider.put=async()=>{if(fail)throw Error('offline');return 'bad';};
    await assert.rejects(f.client.put(bytes));assert.equal(await f.cache.get(cid),null);f.cache.close();
  }
});
test("upload snapshot resists caller and provider mutation and cache failure preserves acknowledgement",async()=>{
  const f=fixture(),input=bytes.slice(),cid=await rawMediaBlockCid(bytes);
  f.provider.put=async block=>{assert.deepEqual(block,bytes);block.fill(9);return cid;};
  const pending=f.client.put(input);input.fill(8);assert.equal(await pending,cid);
  assert.deepEqual(await f.cache.get(cid),bytes);f.cache.close();assert.equal(await f.client.put(bytes),cid);
});
test("withdrawal or abort at upload acknowledgement refuses retention",async()=>{
  for(const reason of ['revoke','abort']){
    const f=fixture(),cid=await rawMediaBlockCid(bytes);
    f.provider.put=async()=>{if(reason==='revoke')f.revoke();else f.abort.abort();return cid;};
    await assert.rejects(f.client.put(bytes));
    const observer=createLocalCiphertextCache({scope:'a'.repeat(64),policy:{enabled:true,maxBytes:3,maxEntries:1,ttlMs:1000},factory:f.factory,current:()=>true,now:()=>1000});
    assert.equal(await observer.get(cid),null);observer.close();f.cache.close();
  }
});
test("upload and download share two adapter operation slots and reject oversized input",async()=>{
  const f=fixture(),cid=await rawMediaBlockCid(bytes);let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});f.provider.put=async()=>{await gate;return cid;};
  await assert.rejects(f.client.put(new Uint8Array(1024*1024+1)));
  const a=f.client.put(bytes),b=f.client.put(bytes);
  await assert.rejects(f.client.put(bytes));await assert.rejects(f.client.get(cid,3));
  release();await Promise.all([a,b]);assert.deepEqual(await f.client.get(cid,3),bytes);f.cache.close();
});


test("noncanonical CID reads refuse cache lookup and provider fallback",async()=>{
  const f=fixture(),cid=await rawMediaBlockCid(bytes);let reads=0;
  const cache={...f.cache,async get(){reads++;return null;}};
  const client=createCachedMediaBlocks({provider:f.provider,cache,current:()=>true,signal:f.abort.signal});
  try{
    for(const invalid of [cid.slice(0,-1)+'b','bafkreiz'+cid.slice(7)])await assert.rejects(client.get(invalid,3));
    assert.equal(reads,0);assert.equal(f.gets(),0);
    assert.deepEqual(await client.get(cid,3),bytes);assert.equal(reads,1);assert.equal(f.gets(),1);
  }finally{f.cache.close();}
});
