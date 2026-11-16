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
