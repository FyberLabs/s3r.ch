import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSharedTransferConcurrency} from './ipfs-transfer-concurrency';
import {createKuboBlockClient} from './ipfs-kubo-client';
import {rawMediaBlockCid} from './ipfs-media-blocks';
function lockManager() {
  const held = new Set<string>();
  return {held, request: async (name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<unknown>) => {
    assert.deepEqual(options, {mode: 'exclusive', ifAvailable: true});
    if (held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({name, mode: 'exclusive'}); } finally { held.delete(name); }
  }} as unknown as Pick<LockManager, 'request'> & {held: Set<string>};
}
function deferred() {let resolve!: () => void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
const signal=()=>new AbortController().signal;
test('independent clients share two slots without queuing excess work', async()=>{
  const locks=lockManager(),gate=deferred();let calls=0;
  const make=()=>createSharedTransferConcurrency({locks,current:()=>true});
  const work=async()=>{calls++;await gate.promise;return 7;};
  const a=make().run(signal(),work),b=make().run(signal(),work);
  await assert.rejects(make().run(signal(),work));assert.equal(calls,2);assert.equal(locks.held.size,2);
  gate.resolve();assert.deepEqual(await Promise.all([a,b]),[7,7]);assert.equal(locks.held.size,0);
  assert.equal(await make().run(signal(),async()=>8),8);
});
test('abort-ignoring work retains its slot until settlement and never returns stale success',async()=>{
  const locks=lockManager(),gate=deferred(),abort=new AbortController();
  const slots=createSharedTransferConcurrency({locks,current:()=>true});
  const a=slots.run(abort.signal,()=>gate.promise),b=slots.run(signal(),()=>gate.promise);
  const rejected=assert.rejects(a);abort.abort();
  await assert.rejects(createSharedTransferConcurrency({locks,current:()=>true}).run(signal(),async()=>{}));
  assert.equal(locks.held.size,2);gate.resolve();await rejected;await b;assert.equal(locks.held.size,0);
});
test('failure releases slots, revoked authority and missing capability never execute work',async()=>{
  const locks=lockManager();let allowed=true,calls=0;
  const slots=createSharedTransferConcurrency({locks,current:()=>allowed});
  await assert.rejects(slots.run(signal(),async()=>{throw Error('offline');}));assert.equal(locks.held.size,0);
  await assert.rejects(slots.run(signal(),async()=>{allowed=false;}));assert.equal(locks.held.size,0);
  await assert.rejects(slots.run(signal(),async()=>{calls++;}));
  const abort=new AbortController();abort.abort();allowed=true;
  await assert.rejects(slots.run(abort.signal,async()=>{calls++;}));
  await assert.rejects(createSharedTransferConcurrency({locks:{request:async()=>{throw Error('denied');}} as unknown as LockManager,current:()=>true}).run(signal(),async()=>{calls++;}));
  const navigatorDescriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  try {
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
    await assert.rejects(createSharedTransferConcurrency({current:()=>true}).run(signal(),async()=>{calls++;}));
  } finally {
    if(navigatorDescriptor)Object.defineProperty(globalThis,'navigator',navigatorDescriptor);
    else Reflect.deleteProperty(globalThis,'navigator');
  }
  assert.equal(calls,0);
});
test('authority is rechecked when asynchronous browser lock callback arrives',async()=>{
  let allowed=true,calls=0;const gate=deferred();
  const locks={async request(_name: string,_options: LockOptions,callback: (lock: Lock)=>Promise<unknown>){await gate.promise;return callback({name:'slot',mode:'exclusive'});}} as unknown as LockManager;
  const pending=createSharedTransferConcurrency({locks,current:()=>allowed}).run(signal(),async()=>{calls++;});
  allowed=false;gate.resolve();await assert.rejects(pending);assert.equal(calls,0);
});
test('Kubo holds shared slots through provider completion and saturation sends no request',async()=>{
  const locks=lockManager(),gate=deferred(),bytes=new Uint8Array([1]),cid=await rawMediaBlockCid(bytes);let calls=0,reservations=0;
  const make=()=>createKuboBlockClient({endpoint:'https://provider.example',maxBytes:10,current:()=>true,signal:signal(),sharedConcurrency:createSharedTransferConcurrency({locks,current:()=>true}),sharedBudget:{async reserve(){reservations++;}}},async()=>{calls++;await gate.promise;return new Response(bytes);});
  const a=make().get(cid,1),b=make().get(cid,1);await assert.rejects(make().get(cid,1));
  assert.equal(calls,2);assert.equal(reservations,2);gate.resolve();await Promise.all([a,b]);
  await make().get(cid,1);assert.equal(calls,3);assert.equal(locks.held.size,0);
});
