import {test} from "node:test";
import assert from "node:assert/strict";
import {IDBFactory} from "fake-indexeddb";
import {createSharedTransferBudget} from "./ipfs-transfer-budget";
import {createKuboBlockClient} from "./ipfs-kubo-client";
import {rawMediaBlockCid} from "./ipfs-media-blocks";
const signal=()=>new AbortController().signal;
test("independent instances atomically share one rolling allowance and survive reopening",async()=>{
  const factory=new IDBFactory();let now=1000;
  const options={factory,maxBytesPerMinute:3,current:()=>true,now:()=>now};
  const a=createSharedTransferBudget(options),b=createSharedTransferBudget(options);
  const result=await Promise.allSettled([a.reserve(3,signal()),b.reserve(3,signal())]);
  assert.equal(result.filter(item=>item.status==='fulfilled').length,1);a.close();b.close();
  const reopened=createSharedTransferBudget(options);
  now=60999;await assert.rejects(reopened.reserve(1,signal()));
  now=61000;await reopened.reserve(3,signal());reopened.close();
});
test("Kubo clients reserve before dispatch, and a failed provider still consumes shared allowance",async()=>{
  const factory=new IDBFactory(),bytes=new Uint8Array([1,2,3]),cid=await rawMediaBlockCid(bytes);let calls=0;
  const make=()=>createKuboBlockClient({endpoint:'https://provider.example',maxBytes:100,current:()=>true,signal:signal(),sharedBudget:createSharedTransferBudget({factory,maxBytesPerMinute:3,current:()=>true})},async()=>{calls++;return new Response('offline',{status:503});});
  await assert.rejects(make().get(cid,3));await assert.rejects(make().get(cid,3));assert.equal(calls,1);
});
test("revocation during admission prevents dispatch without refunding committed budget",async()=>{
  const factory=new IDBFactory(),budget=createSharedTransferBudget({factory,maxBytesPerMinute:3,current:()=>true});let allowed=true,calls=0;
  const client=createKuboBlockClient({endpoint:'https://provider.example',maxBytes:100,current:()=>allowed,signal:signal(),sharedBudget:{async reserve(bytes,s){await budget.reserve(bytes,s);allowed=false;}}},async()=>{calls++;return new Response(new Uint8Array([1,2,3]));});
  await assert.rejects(client.get(await rawMediaBlockCid(new Uint8Array([1,2,3])),3));assert.equal(calls,0);await assert.rejects(budget.reserve(1,signal()));budget.close();
});
test("invalid policy, closed authority and aborted signals fail before opening storage",async()=>{
  const factory=new IDBFactory();for(const maxBytesPerMinute of [0,NaN,Infinity,8*1024*1024+1])assert.throws(()=>createSharedTransferBudget({factory,maxBytesPerMinute,current:()=>true}));
  const budget=createSharedTransferBudget({factory,maxBytesPerMinute:10,current:()=>false});await assert.rejects(budget.reserve(1,signal()));
  const active=createSharedTransferBudget({factory,maxBytesPerMinute:10,current:()=>true}),abort=new AbortController();abort.abort();await assert.rejects(active.reserve(1,abort.signal));active.close();await assert.rejects(active.reserve(1,signal()));assert.deepEqual(await factory.databases(),[]);
});
test("persisted clock watermark rejects rollback and row-count bound caps tiny attempts",async()=>{
  const factory=new IDBFactory();let now=1000;
  const budget=createSharedTransferBudget({factory,maxBytesPerMinute:1000,current:()=>true,now:()=>now});
  await budget.reserve(1,signal());now=999;await assert.rejects(budget.reserve(1,signal()));now=1000;
  for(let i=1;i<128;i++)await budget.reserve(1,signal());await assert.rejects(budget.reserve(1,signal()));
  now=61000;await budget.reserve(1,signal());budget.close();
});
test("unavailable shared storage is fail-closed and never bypasses to provider",async()=>{
  let calls=0;const broken={open(){throw Error('blocked');}} as unknown as IDBFactory;
  const budget=createSharedTransferBudget({factory:broken,maxBytesPerMinute:3,current:()=>true});
  const client=createKuboBlockClient({endpoint:'https://provider.example',maxBytes:100,current:()=>true,signal:signal(),sharedBudget:budget},async()=>{calls++;return new Response();});
  await assert.rejects(client.get(await rawMediaBlockCid(new Uint8Array([1])),1));assert.equal(calls,0);budget.close();
});
