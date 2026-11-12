import test from "node:test";
import assert from "node:assert/strict";
import { encodeFeedCache, decodeFeedCache, tenantFeedCache } from "./tenant-feed-cache";
import { RecordConflict, type RecordStore, type StoredRecord } from "./record-store";
import type { MemoryStore } from "./gun-server";
import type { FeedItem, SourcePull } from "./feed-types";
const row: FeedItem = {id:"post",source:"rss",kind:"post",author:"a",body:"old body",ts:1,permalink:"https://example.org/post",tags:[],provenance:"rss"};
const state = (items: FeedItem[] = [row]): MemoryStore => ({items:new Map(items.map(x=>[x.id,x])),windows:new Map([["feed",items]]),retired:new Set(),seededAt:null,sourcesOk:1,sourcesTried:1,error:null});
const pull = (items: FeedItem[]): SourcePull => ({items,windows:[{key:"feed",items}],sourcesOk:1,sourcesTried:1,error:null});
function backend(initial: MemoryStore | null) {
  let current: StoredRecord | null = initial ? {bytes:encodeFeedCache(initial),revision:"1"} : null;
  let serial = 1, writes = 0;
  const store: RecordStore = {
    async get() {return current;},
    async put(ns,name,bytes,expected) {assert.equal(ns,"cache");assert.equal(name,"public-feed"); if ((current?.revision ?? null)!==expected) throw new RecordConflict(); writes++; const revision=String(++serial);current={bytes:bytes.slice(),revision};return revision;},
    async delete(){current=null;},
  };
  return {store,read:()=>current,writes:()=>writes};
}

test("imports a legacy local cache only when missing, and restores authoritative remote", async () => {
  const b=backend(null); let published:MemoryStore|undefined;
  const cache=tenantFeedCache(b.store,()=>state(),s=>{published=s;},()=>{});
  await cache.restore();assert.equal(b.writes(),1);assert.equal(published?.items.get("post")?.body,row.body);
  const empty=state([]);await b.store.put("cache","public-feed",encodeFeedCache(empty),b.read()!.revision);
  await cache.restore();assert.equal(published?.items.size,0);assert.equal(b.writes(),2);
  await b.store.delete("cache","public-feed",b.read()!.revision);
  await assert.rejects(cache.restore()); assert.equal(b.writes(),2,"observed deletion never reimports local content");
});

test("successful empty windows remove posts, failed windows preserve their last value", async () => {
  const b=backend(state());let published=state();const cache=tenantFeedCache(b.store,()=>state(),s=>{published=s;},()=>{});
  await cache.refresh(async()=>({items:[],windows:[],sourcesOk:0,sourcesTried:1,error:"private upstream URL"}));
  assert.equal(published.items.get("post")?.body,row.body);
  assert.equal(new TextDecoder().decode(b.read()!.bytes).includes("private upstream URL"),false);
  const result=await cache.refresh(async()=>pull([]));assert.equal(result.written,0);
  assert.equal(published.items.size,0);assert.equal(published.retired.has("post"),true);
  assert.equal(new TextDecoder().decode(b.read()!.bytes).includes(row.body),false);
});

test("conflicts reload and refetch instead of replaying stale source windows", async () => {
  const b=backend(state());const put=b.store.put;let first=true,fetches=0,published=state();
  b.store.put=async(...args)=>{if(first){first=false;await put("cache","public-feed",encodeFeedCache(state([])),b.read()!.revision);throw new RecordConflict();}return put(...args);};
  const cache=tenantFeedCache(b.store,()=>state(),s=>{published=s;},()=>{});
  await cache.refresh(async()=>{fetches++;return pull(fetches===1?[row]:[]);});
  assert.equal(fetches,2);assert.equal(published.items.size,0);
});

test("failed reads, writes and corrupt records never publish or overwrite the cache", async () => {
  for(const mode of ["read","write","corrupt"]){
    const b=backend(state());let published=0,writes=0;
    if(mode==="read")b.store.get=async()=>{throw new Error("unavailable");};
    if(mode==="corrupt")b.store.get=async()=>({bytes:new TextEncoder().encode('{"version":999}'),revision:"x"});
    b.store.put=async()=>{writes++;throw new Error("secret");};
    const cache=tenantFeedCache(b.store,()=>state(),()=>{published++;},()=>{});
    await assert.rejects(cache.refresh(async()=>pull([])));assert.equal(published,0);assert.equal(writes,mode==="write"?1:0);
  }
});

test("bounded conflict retries also cover competing initial imports", async () => {
  const b=backend(null);let attempts=0;
  b.store.put=async()=>{attempts++;throw new RecordConflict();};
  const cache=tenantFeedCache(b.store,()=>state(),()=>assert.fail("must not publish"),()=>{});
  await assert.rejects(cache.restore());assert.equal(attempts,3);
  await assert.rejects(cache.refresh(async()=>pull([])));assert.equal(attempts,6);
});

test("snapshot decoder rejects malformed metadata, windows and records",()=>{
  const valid=JSON.parse(new TextDecoder().decode(encodeFeedCache(state())));
  for(const patch of [{version:2},{items:null},{sourceWindows:null},{retiredIds:null},{seededAt:1},{seededAt:"bad"},{sourcesOk:-1},{sourcesTried:0},{error:{}},{items:[null]},{items:[{...row,body:{},ts:"bad"}]},{items:[{...row,tags:[1]}]},{items:[{id:"x",source:"unknown"}]},{items:[row,row]},{sourceWindows:[["feed",[row]],["feed",[row]]]},{sourceWindows:[["feed",[row,row]]]},{sourceWindows:[["feed",[{...row,id:"other"}]]]},{retiredIds:["post"]},{retiredIds:[2]}]){
    assert.throws(()=>decodeFeedCache(new TextEncoder().encode(JSON.stringify({...valid,...patch}))));
  }
  for(const bytes of [new Uint8Array(),new Uint8Array([255]),new TextEncoder().encode("null")])assert.throws(()=>decodeFeedCache(bytes));
  assert.equal(decodeFeedCache(encodeFeedCache(state())).items.size,1);
});

test("restarting after remote adoption does not resurrect a deleted remote cache", async () => {
  const b=backend(null), local={...state(),tenantRecordInitialized:true};
  const cache=tenantFeedCache(b.store,()=>local,()=>assert.fail("no publication"),()=>{});
  await assert.rejects(cache.restore());
  await assert.rejects(cache.refresh(async()=>pull([row])));
  assert.equal(b.writes(),0);
});


test("oversized snapshots and failed initial imports are rejected", async () => {
  const huge=state([{...row,body:"x".repeat(8*1024*1024)}]);
  assert.throws(()=>encodeFeedCache(huge));
  assert.throws(()=>decodeFeedCache(new Uint8Array(8*1024*1024+1)));
  const b=backend(null);b.store.put=async()=>{throw new Error("private provider detail");};
  await assert.rejects(tenantFeedCache(b.store,()=>state(),()=>assert.fail(),()=>{}).restore(),{message:"Public feed cache unavailable"});
});

test("adoption is durable before a remote commit even when publication crashes", async () => {
  const b=backend(null);let local=state(),intent=false;
  const mark=()=>{intent=true;local={...local,tenantRecordInitialized:true};};
  const put=b.store.put;
  b.store.put=async(...args)=>{assert.equal(intent,true);return put(...args);};
  await assert.rejects(tenantFeedCache(b.store,()=>local,()=>{throw new Error("disk full");},mark).restore());
  assert.equal(b.writes(),1);
  await b.store.delete("cache","public-feed",b.read()!.revision);
  await assert.rejects(tenantFeedCache(b.store,()=>local,()=>assert.fail(),mark).restore());
  assert.equal(b.writes(),1);
  const empty=backend(null);
  await assert.rejects(tenantFeedCache(empty.store,()=>state(),()=>assert.fail(),()=>{throw new Error("disk full");}).refresh(async()=>pull([])));
  assert.equal(empty.writes(),0);
});

test("retirement history cannot exhaust the authoritative record budget",()=>{
  const previous=state();
  previous.retired=new Set(Array.from({length:64030},(_,i)=>String(i).padEnd(128,"x")));
  const bytes=encodeFeedCache(previous);
  assert.ok(bytes.length<2048);
  assert.deepEqual([...decodeFeedCache(bytes).retired],[]);
  assert.equal(previous.retired.size,64030,"local deletion replay retains its own history");
});
