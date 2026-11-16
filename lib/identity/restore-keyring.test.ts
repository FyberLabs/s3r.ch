// Native keyring, crypto and IndexedDB contracts: CI only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {historyState} from 'sociacl-ids';
import {importKeyring,exportKeyring,closeKeyring} from 'sociacl-ids/keyring';
import {restoreExistingKeyring} from './restore-keyring';
import {restoredKeyringRecords} from './restored-keyring-storage';
import {canonical} from './device-storage';
import {base64UrlToBytes} from './wrap';
import {createIndexedDbMeshKeyStore,openMeshDb,MESH_STORE_NAME} from './idb';
import {ensureLocalMeshKey} from './mesh';
const fixture=(name:string)=>JSON.parse(readFileSync(new URL('../.pairing-test-vectors/'+name+'.json',import.meta.url),'utf8'));
async function setup(){
 const vectors=fixture('browser-keyring'),records=fixture('records'),v=vectors.accept[1],{principal,pub,epub,rotationSeq}=v.fields;
 const identity={principal,pub,epub,rotationSeq},factory=new IDBFactory(),abort=new AbortController();let active=true,refuse=false;
 const state=():any=>{if(refuse)throw Error('owner changed');return {rotations:v.rotationNames.map((name:string)=>records.accept.find((r:any)=>r.name===name).input),context:{jwks:records.context.jwks,links:new Map(records.context.links),revocations:[],now:records.context.now,policy:records.context.policy,pinnedIss:new Set(records.context.pinnedIss),genesisEpubBindings:v.genesisBindings,history:(p:any,at:number,until:number)=>records.context.authenticatedAccounts.includes(p)?{ok:true,value:historyState(p,[],at,until)}:{ok:false,reason:'missing-history'}}};};
 const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 const scope={sourceOrigin:'https://s3r.ch',destinationOrigin:'https://s3r.ch',application:'s3r.ch',tenant:'fixture',audience:'fixture'};
 const input={scope,factory,current:()=>active,signal:abort.signal,keyringState:async(expected:any)=>{assert.deepEqual(expected,identity);return state;},
  protect:async()=>({key,protection:{version:1 as const,rpId:'s3r.ch' as const,credentialId:'fixture',prfSalt:'fixture'}})};
 return {v,identity,input,key,state,abort,factory,bytes:()=>new TextEncoder().encode(JSON.stringify(v.fields)),refuse:()=>refuse=true,deactivate:()=>active=false};
}
test('fresh browser restores complete historical keyring without transfer metadata or replacement',async()=>{
 const f=await setup(),result=await restoreExistingKeyring(f.bytes(),f.input);
 assert.equal(result.outcome,'stored');const [record]=await restoredKeyringRecords(f.factory);
 assert.equal(record.identity.principal,f.identity.principal);assert.equal('binding' in record,false);assert.equal('completion' in record,false);
 assert.equal(JSON.stringify(record).includes(f.v.fields.priv),false);
 const packed=base64UrlToBytes(record.sealed),aad=new TextEncoder().encode(canonical({kind:record.kind,identity:record.identity,scope:record.scope,generation:record.generation,historyAt:record.historyAt,payloadHash:record.payloadHash}));
 const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(packed.slice(0,12)),additionalData:aad},f.key,new Uint8Array(packed.slice(12))));
 const handle=importKeyring(plain,record.identity,f.state);
 try{assert.deepEqual(Buffer.from(exportKeyring(handle,f.state)),Buffer.from(f.v.encodedHex,'hex'));}finally{plain.fill(0);closeKeyring(handle);}
 const repeated=await restoreExistingKeyring(f.bytes(),f.input);assert.equal(repeated.outcome,'existing');assert.equal(repeated.record.sealed,record.sealed);
 let generated=false;
 await assert.rejects(ensureLocalMeshKey({address:'0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',domain:'s3r.ch',uri:'https://s3r.ch',store:createIndexedDbMeshKeyStore(f.factory),createPair:async()=>{generated=true;throw Error();},signMessage:async()=>{throw Error();}}));assert.equal(generated,false);
});
test('incomplete material, unavailable authority, cancellation and changed account leave storage empty',async()=>{
 for(const mode of ['missing','owner','cancel','account']){
  const f=await setup();let bytes=f.bytes();
  if(mode==='missing')bytes=new TextEncoder().encode(JSON.stringify({...f.v.fields,retired:[]}));
  if(mode==='owner')f.refuse();
  if(mode==='cancel')f.abort.abort();
  if(mode==='account')f.deactivate();
  await assert.rejects(restoreExistingKeyring(bytes,f.input));assert.deepEqual(await restoredKeyringRecords(f.factory),[]);
 }
});
test('fresh final authority and transaction cancellation prevent partial restoration',async t=>{
 const f=await setup();let reads=0;
 const input={...f.input,keyringState:async(id:any)=>{if(++reads===3)f.refuse();return f.input.keyringState(id);}};
 await assert.rejects(restoreExistingKeyring(f.bytes(),input));assert.deepEqual(await restoredKeyringRecords(f.factory),[]);
 const g=await setup(),add=IDBObjectStore.prototype.add;
 t.mock.method(IDBObjectStore.prototype,'add',function(this:IDBObjectStore,value:unknown,key?:IDBValidKey){const request=add.call(this,value,key);g.abort.abort();return request;});
 await assert.rejects(restoreExistingKeyring(g.bytes(),g.input));assert.deepEqual(await restoredKeyringRecords(g.factory),[]);
});
test('an existing local record is preserved instead of replaced by a restore',async()=>{
 const f=await setup(),db=await openMeshDb(f.factory);
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction(MESH_STORE_NAME,'readwrite');tx.objectStore(MESH_STORE_NAME).add({address:'existing',privateMarker:'preserved'});tx.oncomplete=()=>resolve();tx.onabort=()=>reject(Error());});db.close();
 await assert.rejects(restoreExistingKeyring(f.bytes(),f.input));assert.deepEqual(await restoredKeyringRecords(f.factory),[]);
});
