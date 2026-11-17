import test from "node:test";
import assert from "node:assert/strict";
import {IDBFactory} from "fake-indexeddb";
import {createLocalCiphertextCache} from "./ipfs-local-cache";
import {rawMediaBlockCid} from "./ipfs-media-blocks";
const policy={enabled:true,maxBytes:10,maxEntries:2,ttlMs:1000};
const scope="a".repeat(64), other="b".repeat(64);
const block=new Uint8Array([1,2,3]);
const setup=()=>{const factory=new IDBFactory();let at=1000,allowed=true;return {factory,now:()=>at,current:()=>allowed,time:(n:number)=>{at=n;},allow:(v:boolean)=>{allowed=v;}};};
test("opt-out never opens storage and malformed policies fail",async()=>{
 const cache=createLocalCiphertextCache({scope,policy:{...policy,enabled:false},current:()=>true,factory:{open(){assert.fail();}} as unknown as IDBFactory});
 await assert.rejects(cache.put(await rawMediaBlockCid(block),block));await assert.rejects(cache.get('bad'));
 for(const p of [{...policy,maxBytes:0},{...policy,maxEntries:65},{...policy,ttlMs:86400001}])assert.throws(()=>createLocalCiphertextCache({scope,policy:p,current:()=>true}));
});
test("ciphertext round trip is scoped and snapshots caller mutations",async()=>{
 const s=setup(),cache=createLocalCiphertextCache({scope,policy,...s}),cid=await rawMediaBlockCid(block),copy=block.slice();
 const pending=cache.put(cid,copy);copy.fill(9);await pending;
 assert.deepEqual(await cache.get(cid),block);
 const foreign=createLocalCiphertextCache({scope:other,policy,...s});assert.equal(await foreign.get(cid),null);
 const returned=(await cache.get(cid))!;returned.fill(8);assert.deepEqual(await cache.get(cid),block);
 await foreign.clear();assert.deepEqual(await cache.get(cid),block);
});
test("concurrent instances cannot race past aggregate byte and entry budgets",async()=>{
 const s=setup(),a=createLocalCiphertextCache({scope,policy:{...policy,maxBytes:4},...s}),b=createLocalCiphertextCache({scope:other,policy:{...policy,maxBytes:4},...s});
 const cid=await rawMediaBlockCid(block),results=await Promise.allSettled([a.put(cid,block),b.put(cid,block)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const s2=setup(),c=createLocalCiphertextCache({scope,policy:{...policy,maxEntries:1},...s2});
 await c.put(cid,block);await assert.rejects(c.put(await rawMediaBlockCid(new Uint8Array([4])),new Uint8Array([4])));
});
test("expiry survives reopen, retries never extend retention, and expired bytes free quota",async()=>{
 const s=setup(),cid=await rawMediaBlockCid(block),a=createLocalCiphertextCache({scope,policy,...s});
 await a.put(cid,block);s.time(1500);await a.put(cid,block);a.close();
 const b=createLocalCiphertextCache({scope,policy,...s});s.time(2000);assert.equal(await b.get(cid),null);
 await b.put(cid,block);assert.deepEqual(await b.get(cid),block);
 s.time(1999);await assert.rejects(b.get(cid));
});
test("revoked context and cancellation refuse access, but opt-out can erase",async()=>{
 const s=setup(),cache=createLocalCiphertextCache({scope,policy,...s}),cid=await rawMediaBlockCid(block);
 await cache.put(cid,block);s.allow(false);await assert.rejects(cache.get(cid));await assert.rejects(cache.put(cid,block));
 cache.close();await cache.clear();s.allow(true);
 const next=createLocalCiphertextCache({scope,policy,...s});assert.equal(await next.get(cid),null);
 const controller=new AbortController();controller.abort();await assert.rejects(next.put(cid,block,controller.signal));
});
test("bad CID or altered bytes never enter storage",async()=>{
 const s=setup(),cache=createLocalCiphertextCache({scope,policy,...s}),cid=await rawMediaBlockCid(block);
 await assert.rejects(cache.put(cid,new Uint8Array([4,5,6])));assert.equal(await cache.get(cid),null);
 await assert.rejects(cache.put(cid,new Uint8Array(11)));
});
test("cleanup works despite clock rollback after opt-out",async()=>{
 const s=setup(),cache=createLocalCiphertextCache({scope,policy,...s}),cid=await rawMediaBlockCid(block);
 await cache.put(cid,block);s.time(0);cache.close();await cache.clear();
 s.time(1000);assert.equal(await createLocalCiphertextCache({scope,policy,...s}).get(cid),null);
});
test("expiry is checked again after asynchronous integrity verification",async(t)=>{
 const s=setup(),cache=createLocalCiphertextCache({scope,policy,...s}),cid=await rawMediaBlockCid(block);await cache.put(cid,block);
 const digest=crypto.subtle.digest.bind(crypto.subtle);
 t.mock.method(crypto.subtle,'digest',async(...args:Parameters<typeof digest>)=>{const result=await digest(...args);s.time(2000);return result;});
 assert.equal(await cache.get(cid),null);
});
test("hashing and cleanup share the per-instance outstanding-operation bound",async(t)=>{
 const s=setup(),cache=createLocalCiphertextCache({scope,policy,...s}),cid=await rawMediaBlockCid(block);
 const digest=crypto.subtle.digest.bind(crypto.subtle),releases:Array<()=>void>=[];
 t.mock.method(crypto.subtle,'digest',async(...args:Parameters<typeof digest>)=>{await new Promise<void>(resolve=>releases.push(resolve));return digest(...args);});
 const pending=Array.from({length:4},()=>cache.put(cid,block));
 await assert.rejects(cache.put(cid,block));await assert.rejects(cache.clear());
 releases.forEach(release=>release());await Promise.all(pending);await cache.clear();
});
test("targeted eviction preserves unrelated blocks and foreign partitions and frees quota",async()=>{
 const s=setup(),p={...policy,maxBytes:9,maxEntries:3};
 const a=createLocalCiphertextCache({scope,policy:p,...s}),b=createLocalCiphertextCache({scope:other,policy:p,...s});
 const cid=await rawMediaBlockCid(block),second=new Uint8Array([4,5,6]),secondCid=await rawMediaBlockCid(second);
 await a.put(cid,block);await a.put(secondCid,second);await b.put(cid,block);
 const third=new Uint8Array([7,8,9]),thirdCid=await rawMediaBlockCid(third);
 await assert.rejects(a.put(thirdCid,third));await a.evict([cid,cid]);
 assert.equal(await a.get(cid),null);assert.deepEqual(await a.get(secondCid),second);assert.deepEqual(await b.get(cid),block);
 await a.put(thirdCid,third);assert.deepEqual(await a.get(thirdCid),third);
});
test("bounded eviction snapshots its selection and works after withdrawal, close and rollback",async()=>{
 const s=setup(),cache=createLocalCiphertextCache({scope,policy,...s}),cid=await rawMediaBlockCid(block);
 const second=new Uint8Array([4]),secondCid=await rawMediaBlockCid(second);
 await cache.put(cid,block);await cache.put(secondCid,second);s.allow(false);s.time(0);cache.close();
 const selection=[cid],pending=cache.evict(selection);selection[0]=secondCid;await pending;
 s.allow(true);s.time(1000);const next=createLocalCiphertextCache({scope,policy,...s});
 assert.equal(await next.get(cid),null);assert.deepEqual(await next.get(secondCid),second);
 await createLocalCiphertextCache({scope,policy:{...policy,enabled:false},...s}).evict([secondCid]);
 assert.equal(await next.get(secondCid),null);await next.evict([cid,secondCid]);
});
test("invalid or already cancelled eviction cannot partially delete",async()=>{
 const s=setup(),cache=createLocalCiphertextCache({scope,policy,...s}),cid=await rawMediaBlockCid(block);await cache.put(cid,block);
 for(const selected of [[],[cid,'bad'],Array(65).fill(cid)])await assert.rejects(cache.evict(selected));
 const abort=new AbortController();abort.abort();await assert.rejects(cache.evict([cid],abort.signal));
 assert.deepEqual(await cache.get(cid),block);
});
test("eviction shares the pending work bound with hashing",async(t)=>{
 const s=setup(),cache=createLocalCiphertextCache({scope,policy,...s}),cid=await rawMediaBlockCid(block);
 const digest=crypto.subtle.digest.bind(crypto.subtle),releases:Array<()=>void>=[];
 t.mock.method(crypto.subtle,'digest',async(...args:Parameters<typeof digest>)=>{await new Promise<void>(resolve=>releases.push(resolve));return digest(...args);});
 const pending=Array.from({length:4},()=>cache.put(cid,block));await assert.rejects(cache.evict([cid]));
 releases.forEach(release=>release());await Promise.all(pending);await cache.evict([cid]);
});


test("noncanonical CID operations refuse before opening storage or hashing",async t=>{
 const s=setup(),cid=await rawMediaBlockCid(block);let opens=0,hashes=0;
 const open=s.factory.open.bind(s.factory),digest=crypto.subtle.digest.bind(crypto.subtle);
 t.mock.method(s.factory,'open',(...args:Parameters<typeof open>)=>{opens++;return open(...args);});
 t.mock.method(crypto.subtle,'digest',(...args:Parameters<typeof digest>)=>{hashes++;return digest(...args);});
 const cache=createLocalCiphertextCache({scope,policy,...s});
 try{
  for(const invalid of [cid.slice(0,-1)+'b','bafkreiz'+cid.slice(7),cid.toUpperCase(),'b'+'a'.repeat(58)]){
   await assert.rejects(cache.get(invalid));await assert.rejects(cache.put(invalid,block));await assert.rejects(cache.evict([cid,invalid]));
  }
  assert.equal(opens,0);assert.equal(hashes,0);
  await cache.put(cid,block);assert.deepEqual(await cache.get(cid),block);
  cache.close();await cache.evict([cid]);
  assert.equal(await createLocalCiphertextCache({scope,policy,...s}).get(cid),null);
 }finally{cache.close();}
});
