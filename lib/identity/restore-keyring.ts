import {admitKeyring,exportKeyring,importKeyring,closeKeyring,type KeyringMaterial,type KeyringState} from 'sociacl-ids/keyring';
import type {Identity,Scope} from 'sea-device-link';
import {saveRestoredKeyring,preflightRestoredKeyring} from './restored-keyring-storage';
import type {DeviceProtection} from './device-storage';
/** Restore only complete existing material; no key generation or rotation. */
export type RestoreKeyringInput={scope:Scope;current:()=>boolean;signal:AbortSignal;
 keyringState:(identity:Identity)=>Promise<KeyringState>;protect:()=>Promise<{key:CryptoKey;protection:DeviceProtection}>;factory?:IDBFactory};
export async function restoreExistingKeyring(bytes:Uint8Array,input:RestoreKeyringInput){
 const guard=()=>{input.signal.throwIfAborted();if(!input.current())throw Error('Identity context changed');};guard();
 if(!bytes.length||bytes.length>524288)throw Error('Complete keyring required');
 const material=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)) as KeyringMaterial;
 const identity={principal:material.principal,pub:material.pub,epub:material.epub,rotationSeq:material.rotationSeq};
 if(![identity.principal,identity.pub,identity.epub].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(v))||!Number.isSafeInteger(identity.rotationSeq)||identity.rotationSeq<0)throw Error('Invalid existing identity');
 const state=await input.keyringState(identity);guard();const handle=admitKeyring(material,identity,state);
 let canonical:Uint8Array|undefined;
 try{
  canonical=exportKeyring(handle,state);
  return await restoreCanonicalKeyring(canonical,identity,input);
 }finally{canonical?.fill(0);closeKeyring(handle);}
}

/** Canonical import boundary shared by complete exports and decrypted recovery.
 * Every path validates current owner history before asking for a passkey. */
export async function restoreCanonicalKeyring(bytes:Uint8Array,identity:Identity,input:RestoreKeyringInput){
 const guard=()=>{input.signal.throwIfAborted();if(!input.current())throw Error('Identity context changed');};guard();
 const canonical=new Uint8Array(bytes);let handle:ReturnType<typeof importKeyring>|undefined;
 try{
  const state=await input.keyringState(identity);guard();handle=importKeyring(canonical,identity,state);
  const existing=await preflightRestoredKeyring({identity,scope:input.scope,keyring:canonical,factory:input.factory});guard();
  if(existing){
   const fresh=await input.keyringState(identity);guard();const checked=importKeyring(canonical,identity,fresh);
   try{if(existing.historyAt>fresh().context.now)throw Error('Restored history changed');return {record:existing,outcome:'existing' as const};}finally{closeKeyring(checked);}
  }
  // Known invalid, conflicting and exact-retry cases never create a credential.
  const held=await input.protect();guard();

  return await saveRestoredKeyring({...input,...held,identity,keyring:canonical,beforeCommit:async()=>{
   guard();const fresh=await input.keyringState(identity);guard();const checked=importKeyring(canonical!,identity,fresh);
   try{return {historyAt:fresh().context.now,check:()=>{guard();fresh();}};}finally{closeKeyring(checked);}
  }});

 }finally{canonical.fill(0);if(handle)closeKeyring(handle);}
}
