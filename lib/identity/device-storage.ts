import type {Binding, Checkpoint, Completion, CommitInput} from 'sea-device-link';
import {openMeshDb,MESH_STORE_NAME,isMeshKeyRecord} from './idb';
import {bytesToBase64Url,base64UrlToBytes,type SeaWrapRpId} from './wrap';
import {createPrfCredential,evaluatePrf} from './webauthn-prf';
export type DeviceProtection={version:1;rpId:SeaWrapRpId;credentialId:string;prfSalt:string};
export type DeviceRecord={kind:'sea-keyring-v1';address:string;seaPub:string;principal:string;binding:Binding;checkpoint:Checkpoint;
 completion:Completion;payloadHash:string;protection:DeviceProtection;sealed:string};
const fail=():never=>{throw Error('Protected identity unavailable');};
export const deviceRecordKey=(principal:string)=>'sea:'+principal;
export const canonical=(value:unknown):string=>JSON.stringify(value,function(_,v){return v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v;});
export const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
export function isDeviceRecord(v:unknown):v is DeviceRecord {
 const r=v as DeviceRecord;
 return !!r&&r.kind==='sea-keyring-v1'&&r.address===deviceRecordKey(r.principal)&&r.seaPub===r.binding?.identity.pub&&r.principal===r.binding?.identity.principal&&
  r.completion?.transcript===r.binding?.transcript&&typeof r.sealed==='string'&&r.sealed.length<=800000&&/^[a-f0-9]{64}$/.test(r.payloadHash)&&r.protection?.version===1;
}
export async function deviceRecords(factory=globalThis.indexedDB):Promise<DeviceRecord[]> {
 const db=await openMeshDb(factory);
 return new Promise((resolve,reject)=>{const tx=db.transaction(MESH_STORE_NAME,'readonly'),get=tx.objectStore(MESH_STORE_NAME).getAll(null,65);
  tx.oncomplete=()=>{db.close();if(get.result.length>64)reject(Error('Protected identity unavailable'));else resolve(get.result.filter(isDeviceRecord));};
  tx.onabort=()=>{db.close();reject(Error('Protected identity unavailable'));};});
}
async function protectionKey(raw:Uint8Array):Promise<CryptoKey>{
 try {const base=await crypto.subtle.importKey('raw',new Uint8Array(raw),'HKDF',false,['deriveKey']);
  return await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new Uint8Array(0),info:new TextEncoder().encode('s3r.ch/device-keyring/prf/v1')},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 }finally{raw.fill(0);}
}
export async function prepareDeviceProtection(host:string){
 const result=await createPrfCredential({host,localUser:{id:crypto.getRandomValues(new Uint8Array(32)),name:'s3r.ch receiving device'}});
 const key=await protectionKey(result.prfOutput);
 return {key,protection:{version:1 as const,rpId:result.rpId,credentialId:bytesToBase64Url(result.credentialId),prfSalt:bytesToBase64Url(result.prfSalt)}};
}
export async function unlockDeviceRecord(record:DeviceRecord){
 if(!isDeviceRecord(record))return fail();
 const p=record.protection,raw=await evaluatePrf({rpId:p.rpId,credentialId:base64UrlToBytes(p.credentialId),prfSalt:base64UrlToBytes(p.prfSalt)});
 const key=await protectionKey(raw),packed=base64UrlToBytes(record.sealed);
 const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(packed.slice(0,12)),additionalData:new TextEncoder().encode(canonical(record.binding))},key,new Uint8Array(packed.slice(12))));
 try {const value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(plain));
  if(!value||Object.keys(value).sort().join()!=='keyring,receiverCapability'||typeof value.receiverCapability!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.receiverCapability))return fail();
  return {keyring:base64UrlToBytes(value.keyring),receiverCapability:value.receiverCapability};
 }finally{plain.fill(0);}
}
/** The existing identity DB owns keyring, checkpoint and completion in one row. */
export function createDeviceStorage(input:{factory?:IDBFactory;protection:()=>{key:CryptoKey;protection:DeviceProtection}|undefined;
 receiverCapability:()=>string|undefined;current:()=>boolean;now?:()=>number}){
 const now=input.now??Date.now;
 const guard=(signal?:AbortSignal)=>{signal?.throwIfAborted();if(!input.current())return fail();};
 return {
  async lookup(binding:Binding):Promise<Completion|null>{guard();const rows=await deviceRecords(input.factory);guard();const row=rows.find(r=>r.principal===binding.identity.principal);
   return row&&same(row.binding,binding)?structuredClone(row.completion):null;},
  async commit(value:CommitInput){
   guard(value.signal);const held=input.protection(),capability=input.receiverCapability();if(!held||!capability)return fail();
   const plain=new TextEncoder().encode(JSON.stringify({keyring:bytesToBase64Url(value.keyring),receiverCapability:capability}));
   let sealed:string;
   try {const iv=crypto.getRandomValues(new Uint8Array(12));const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(canonical(value.binding))},held.key,plain));
    const packed=new Uint8Array(iv.length+cipher.length);packed.set(iv);packed.set(cipher,iv.length);sealed=bytesToBase64Url(packed);
   }finally{plain.fill(0);}
   const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(value.keyring)));
   const payloadHash=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');guard(value.signal);
   // Async protection finishes before the final owner check. The transaction
   // rechecks its decision deadline and account fence before the actual write.
   const checkpoint=await value.beforeCommit();guard(value.signal);
   const db=await openMeshDb(input.factory??globalThis.indexedDB);try{guard(value.signal);}catch(e){db.close();throw e;}
   await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(MESH_STORE_NAME,'readwrite'),store=tx.objectStore(MESH_STORE_NAME),get=store.getAll(null,65);
    get.onsuccess=()=>{try{
     guard(value.signal);if(now()>=checkpoint.validUntil||now()>=value.binding.expiresAt||get.result.length>64)throw Error();
     const rows=get.result as unknown[];
     for(const row of rows){
      if(isDeviceRecord(row)){if(row.principal!==value.binding.identity.principal||row.seaPub!==value.binding.identity.pub)throw Error();}
      else if(isMeshKeyRecord(row)){if(row.seaPub!==value.binding.identity.pub)throw Error();}
      else throw Error();
     }
     const existing=rows.find(r=>isDeviceRecord(r)&&r.address===deviceRecordKey(value.binding.identity.principal)) as DeviceRecord|undefined;
     if(existing){if(!same(existing.binding,value.binding)||existing.payloadHash!==payloadHash||!same(existing.completion,value.completion))throw Error();return;}
     const record:DeviceRecord={kind:'sea-keyring-v1',address:deviceRecordKey(value.binding.identity.principal),seaPub:value.binding.identity.pub,principal:value.binding.identity.principal,
      binding:structuredClone(value.binding),checkpoint:structuredClone(checkpoint),completion:structuredClone(value.completion),payloadHash,protection:structuredClone(held.protection),sealed};
     store.add(record);
    }catch{tx.abort();}};
    tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>{db.close();reject(Error('Protected identity unavailable'));};
   });
  },
 };
}
