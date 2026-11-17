import test from 'node:test';
import assert from 'node:assert/strict';
import {connectRecoveryWallet} from './recovery-wallet';
function setup(){
 const events=new Map<string,()=>void>(),calls:any[]=[],abort=new AbortController();let changed=0;
 const provider={on:(name:string,fn:()=>void)=>{events.set(name,fn);},removeListener:(name:string)=>{events.delete(name);},request:async(args:{method:string;params?:unknown[]}):Promise<unknown>=>{calls.push(args);return args.method==='eth_chainId'?'0x1':args.method==='personal_sign'?'0x'+'ab'.repeat(65):['0x0000000000000000000000000000000000000001'];}};
 return {provider,abort,calls,events,get changed(){return changed;},connect:()=>connectRecoveryWallet(provider,abort.signal,()=>changed++)};
}
test('wallet selection signs exact UTF-8 bytes and removes listeners on close',async()=>{
 const f=setup(),wallet=await f.connect(),selection=wallet.current()!;
 assert.equal(selection.chainId,'1');await wallet.signMessage('hello',selection);
 assert.deepEqual(f.calls.find(c=>c.method==='personal_sign').params,['0x68656c6c6f',selection.address]);
 wallet.close();wallet.close();assert.equal(wallet.current(),null);assert.equal(f.events.size,0);
});
test('events during a prompt and away-back changes invalidate the selection',async()=>{
 for(const event of ['accountsChanged','chainChanged','disconnect']){
  const f=setup(),wallet=await f.connect(),selected=wallet.current()!,request=f.provider.request;
  f.provider.request=async args=>{const value=await request(args);if(args.method==='personal_sign'){f.events.get(event)!();f.events.get(event)!();}return value;};
  await assert.rejects(wallet.signMessage('rotation',selected));assert.equal(wallet.current(),null);assert.equal(f.changed,2);wallet.close();
 }
});
test('silent account changes, malformed results and abort refuse signature release',async()=>{
 for(const mode of ['accounts','chain','signature','abort']){
  const f=setup(),wallet=await f.connect(),selected=wallet.current()!,request=f.provider.request;
  f.provider.request=async args=>{
   if(mode==='abort')f.abort.abort();
   if(mode==='accounts'&&args.method==='eth_accounts')return ['0x0000000000000000000000000000000000000002'];
   if(mode==='chain'&&args.method==='eth_chainId')return '0x2';
   if(mode==='signature'&&args.method==='personal_sign')return 'invalid';return request(args);
  };
  await assert.rejects(wallet.signMessage('rotation',selected));wallet.close();
 }
});
test('initial permission event is accepted but malformed selection and changing chains fail closed',async()=>{
 const f=setup(),request=f.provider.request;f.provider.request=async args=>{if(args.method==='eth_requestAccounts')f.events.get('accountsChanged')!();return request(args);};
 const wallet=await f.connect();assert.ok(wallet.current());assert.equal(f.changed,0);wallet.close();
 for(const mode of ['many','no-account','chain','large','changed','cancel','provider']){
  const g=setup(),read=g.provider.request;g.provider.request=async args=>{
   if(args.method==='eth_requestAccounts'&&mode==='many')return ['a','b'];
   if(args.method==='eth_requestAccounts'&&mode==='no-account')return [];
   if(args.method==='eth_chainId'&&mode==='chain')return 'bad';
   if(args.method==='eth_chainId'&&mode==='large')return '0xffffffffffffffff';
   if(args.method==='eth_chainId'&&mode==='changed')g.events.get('chainChanged')!();
   if(mode==='provider')throw Error('refused');return read(args);
  };if(mode==='cancel')g.abort.abort();await assert.rejects(g.connect());assert.equal(g.events.size,0);
 }
 await assert.rejects(connectRecoveryWallet({} as any,new AbortController().signal,()=>{}));
});
