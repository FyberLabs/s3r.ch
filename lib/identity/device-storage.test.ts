import assert from 'node:assert/strict';
import {test} from 'node:test';
import {IDBFactory} from 'fake-indexeddb';
import type {CommitInput,Binding} from 'sea-device-link';
import {createDeviceStorage,deviceRecords,canonical} from './device-storage';
import {base64UrlToBytes} from './wrap';
import {createIndexedDbMeshKeyStore} from './idb';
import {ensureLocalMeshKey} from './mesh';
const identity={principal:'principal',pub:'pub',epub:'epub',rotationSeq:2};
const binding:Binding={session:'s',transcript:'t',expiresAt:5000,scope:{sourceOrigin:'https://s3r.ch',destinationOrigin:'https://s3r.ch',application:'s3r.ch',tenant:'tenant',audience:'audience'},identity};
async function fixture(){
 const factory=new IDBFactory(),key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);let active=true,now=1000;
 const storage=createDeviceStorage({factory,protection:()=>({key,protection:{version:1,rpId:'s3r.ch',credentialId:'credential',prfSalt:'salt'}}),receiverCapability:()=>'a'.repeat(43),current:()=>active,now:()=>now});
 const value:CommitInput={binding,keyring:new TextEncoder().encode('complete-history-and-retired-keys'),completion:{transcript:'t',mac:'mac'},signal:new AbortController().signal,beforeCommit:async()=>({revision:'owner-checkpoint',validUntil:2000})};
 return {factory,key,storage,value,setActive:(v:boolean)=>active=v,setNow:(v:number)=>now=v};
}
test('full bytes and checkpoint commit atomically; exact replay and reload completion never replace identity',async()=>{
 const f=await fixture();await f.storage.commit(f.value);assert.deepEqual(await f.storage.lookup(binding),f.value.completion);
 const [row]=await deviceRecords(f.factory);assert.equal(row.checkpoint.revision,'owner-checkpoint');assert.equal('keyring' in row,false);
 const packed=base64UrlToBytes(row.sealed),plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(packed.slice(0,12)),additionalData:new TextEncoder().encode(canonical(binding))},f.key,new Uint8Array(packed.slice(12)));
 const opened=JSON.parse(new TextDecoder().decode(plain));assert.deepEqual(base64UrlToBytes(opened.keyring),f.value.keyring);
 await f.storage.commit(f.value);assert.equal((await deviceRecords(f.factory))[0].sealed,row.sealed);
 await assert.rejects(f.storage.commit({...f.value,keyring:new Uint8Array([9])}));
 await assert.rejects(f.storage.commit({...f.value,binding:{...binding,transcript:'other'}}));
 await assert.rejects(f.storage.commit({...f.value,binding:{...binding,identity:{...identity,principal:'different'}}}));
 assert.equal((await deviceRecords(f.factory)).length,1);
});
test('owner refusal, cancellation, elapsed checkpoint and changed context leave no completion',async()=>{
 for(const reason of ['authority','cancel','clock','account']){
  const f=await fixture(),abort=new AbortController();f.value.signal=abort.signal;
  f.value.beforeCommit=async()=>{if(reason==='authority')throw Error();if(reason==='cancel')abort.abort();if(reason==='clock')f.setNow(2000);if(reason==='account')f.setActive(false);return {revision:'current',validUntil:2000};};
  await assert.rejects(f.storage.commit(f.value));assert.equal((await deviceRecords(f.factory)).length,0);
 }
});
test('unavailable local protection fails before owner callback or saving',async()=>{
 const factory=new IDBFactory();let called=false;const storage=createDeviceStorage({factory,protection:()=>undefined,receiverCapability:()=>undefined,current:()=>true});
 const f=await fixture();await assert.rejects(storage.commit({...f.value,beforeCommit:async()=>{called=true;return {revision:'x',validUntil:2};}}));assert.equal(called,false);assert.deepEqual(await deviceRecords(factory),[]);
});
test('wallet login does not generate a replacement after protected import',async()=>{
 const f=await fixture();await f.storage.commit(f.value);let generated=false;
 await assert.rejects(ensureLocalMeshKey({address:'0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',domain:'s3r.ch',uri:'https://s3r.ch',store:createIndexedDbMeshKeyStore(f.factory),createPair:async()=>{generated=true;throw Error();},signMessage:async()=>{throw Error();}}));assert.equal(generated,false);
});
