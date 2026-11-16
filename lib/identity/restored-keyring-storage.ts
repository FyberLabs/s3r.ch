import type {Identity, Scope} from 'sea-device-link';
import {openMeshDb,MESH_STORE_NAME} from './idb';
import {canonical,same,deviceProtectionKey,type DeviceProtection} from './device-storage';
import {evaluatePrf} from './webauthn-prf';
import {base64UrlToBytes,bytesToBase64Url} from './wrap';
export type RestoredKeyringRecord={kind:'sea-restored-keyring-v1';address:string;seaPub:string;identity:Identity;scope:Scope;
 generation:0;historyAt:number;payloadHash:string;protection:DeviceProtection;sealed:string};
const fail=():never=>{throw Error('Existing identity restore unavailable');};
export function isRestoredKeyringRecord(value:unknown):value is RestoredKeyringRecord{
 const r=value as RestoredKeyringRecord;
 return !!r&&r.kind==='sea-restored-keyring-v1'&&r.generation===0&&r.address==='sea-restored:'+r.identity?.principal&&r.seaPub===r.identity?.pub&&
  Number.isSafeInteger(r.historyAt)&&r.historyAt>=0&&Number.isSafeInteger(r.identity?.rotationSeq)&&r.identity.rotationSeq>=0&&
  typeof r.sealed==='string'&&r.sealed.length<=800000&&/^[a-f0-9]{64}$/.test(r.payloadHash)&&r.protection?.version===1&&!!r.scope;
}
const aad=(r:Pick<RestoredKeyringRecord,'identity'|'scope'|'generation'|'historyAt'|'payloadHash'>)=>new TextEncoder().encode(canonical({
 kind:'sea-restored-keyring-v1',identity:r.identity,scope:r.scope,generation:r.generation,historyAt:r.historyAt,payloadHash:r.payloadHash}));
export async function restoredKeyringRecords(factory=globalThis.indexedDB):Promise<RestoredKeyringRecord[]>{
 const db=await openMeshDb(factory);
 return new Promise((resolve,reject)=>{const tx=db.transaction(MESH_STORE_NAME,'readonly'),get=tx.objectStore(MESH_STORE_NAME).getAll(null,65);
  tx.oncomplete=()=>{db.close();if(get.result.length>64)reject(Error('Identity storage unavailable'));else resolve(get.result.filter(isRestoredKeyringRecord));};
  tx.onabort=()=>{db.close();reject(Error('Identity storage unavailable'));};});
}
/** Read-only eligibility before creating a passkey. The final write still owns
 * the transactional conflict check; this preflight never authorizes overwrite. */
export async function preflightRestoredKeyring(input:{identity:Identity;scope:Scope;keyring:Uint8Array;factory?:IDBFactory}){
 const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(input.keyring)));
 const payloadHash=Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('');
 const db=await openMeshDb(input.factory??globalThis.indexedDB);
 return await new Promise<RestoredKeyringRecord|null>((resolve,reject)=>{
  const tx=db.transaction(MESH_STORE_NAME,'readonly'),get=tx.objectStore(MESH_STORE_NAME).getAll(null,2);
  tx.oncomplete=()=>{db.close();const rows=get.result;if(!rows.length){resolve(null);return;}
   const prior=rows[0];if(rows.length!==1||!isRestoredKeyringRecord(prior)||!same(prior.identity,input.identity)||!same(prior.scope,input.scope)||prior.payloadHash!==payloadHash){reject(Error('Existing identity restore conflict'));return;}
   resolve(prior);
  };
  tx.onabort=()=>{db.close();reject(Error('Identity storage unavailable'));};
 });
}
export async function openRestoredKeyring(record:RestoredKeyringRecord){
 if(!isRestoredKeyringRecord(record))return fail();
 const p=record.protection,raw=await evaluatePrf({rpId:p.rpId,credentialId:base64UrlToBytes(p.credentialId),prfSalt:base64UrlToBytes(p.prfSalt)});
 const key=await deviceProtectionKey(raw),sealed=base64UrlToBytes(record.sealed);
 return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(sealed.slice(0,12)),additionalData:aad(record)},key,new Uint8Array(sealed.slice(12))));
}
/** Absence-only import, or exact readback after an unknown write outcome. No
 * overwrites, identity replacement, synthetic transfer binding or acknowledgement. */
export async function saveRestoredKeyring(input:{identity:Identity;scope:Scope;keyring:Uint8Array;key:CryptoKey;protection:DeviceProtection;
 current:()=>boolean;beforeCommit:()=>Promise<{historyAt:number;check:()=>void}>;signal:AbortSignal;factory?:IDBFactory}){
 const guard=()=>{input.signal.throwIfAborted();if(!input.current())return fail();};guard();
 const identity=structuredClone(input.identity),scope=structuredClone(input.scope),protection=structuredClone(input.protection),bytes=new Uint8Array(input.keyring);
 try{
  if(!bytes.length||bytes.length>524288)return fail();
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));guard();
  const payloadHash=Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('');
  const before=await input.beforeCommit();guard();before.check();
  const metadata={identity,scope,generation:0 as const,historyAt:before.historyAt,payloadHash};
  const iv=crypto.getRandomValues(new Uint8Array(12)),cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(metadata)},input.key,bytes));
  const packed=new Uint8Array(12+cipher.length);packed.set(iv);packed.set(cipher,12);guard();
  // A fresh owner check follows asynchronous encryption. Its closure fences the
  // actual transaction without inventing a local copy of the owner checkpoint.
  const final=await input.beforeCommit();guard();final.check();
  if(final.historyAt<before.historyAt)return fail();
  const record:RestoredKeyringRecord={kind:'sea-restored-keyring-v1',address:'sea-restored:'+identity.principal,seaPub:identity.pub,
   ...metadata,protection,sealed:bytesToBase64Url(packed)};
  const db=await openMeshDb(input.factory??globalThis.indexedDB);try{guard();final.check();}catch(e){db.close();throw e;}
  return await new Promise<{record:RestoredKeyringRecord;outcome:'stored'|'existing'}>((resolve,reject)=>{
   const tx=db.transaction(MESH_STORE_NAME,'readwrite'),store=tx.objectStore(MESH_STORE_NAME),get=store.getAll(null,65);let accepted=record,outcome:'stored'|'existing'='stored';
   const cancel=()=>{try{tx.abort();}catch{/* Already settled. */}};input.signal.addEventListener('abort',cancel,{once:true});
   get.onsuccess=()=>{try{
    guard();final.check();const rows=get.result as unknown[];
    if(rows.length){
     if(rows.length!==1||!isRestoredKeyringRecord(rows[0]))return cancel();
     const prior=rows[0];
     if(!same(prior.identity,identity)||!same(prior.scope,scope)||prior.payloadHash!==payloadHash||prior.historyAt>final.historyAt)return cancel();
     accepted=prior;outcome='existing';return;
    }
    const add=store.add(record);add.onsuccess=()=>{try{guard();final.check();}catch{cancel();}};
   }catch{cancel();}};
   tx.oncomplete=()=>{input.signal.removeEventListener('abort',cancel);db.close();resolve({record:accepted,outcome});};
   tx.onabort=()=>{input.signal.removeEventListener('abort',cancel);db.close();reject(Error('Existing identity restore conflict'));};
  });
 }finally{bytes.fill(0);}
}
