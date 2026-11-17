import {commitRecoveryCopy} from './recovery-store-commit';
import {signRecoveryCurrentPut,signRecoveryCommit} from 'sociacl-ids/recovery';
import {saveRecoveryCopy,type RecoveryView} from './recovery-store-save';
import {recoveryFileRow,recoveryRowEnvelope,recoveryRowFile} from './recovery-file';
import {recoveryView} from './recovery-store-protocol';
import {prepareEncryptedRecovery} from './prepare-encrypted-recovery';
import {restoreEncryptedRecovery} from './restore-encrypted-recovery';
import {restoreExistingKeyring} from './restore-keyring';
import {restoredKeyringRecords,openRestoredKeyring,type RestoredKeyringRecord} from './restored-keyring-storage';
import {activateDeviceKeyring} from './device-activation';
import {createAuthority} from 'acl-sea-device-authority';
import {createRelay} from 'auth-sea-relay';
import {reconcile,type Identity,type Scope} from 'sea-device-link';
import type {Adapters} from 'sea-device-link-ui';
import {importKeyring,exportKeyring,closeKeyring} from 'sociacl-ids/keyring';
import {createDeviceStorage,deviceRecords,prepareDeviceProtection,unlockDeviceRecord,same,type DeviceRecord} from './device-storage';
import {readBoundedIdentityJson} from './bounded-json';
import {readSingleUnlockedIdentity,readUnlockedMeshRevision,rememberUnlockedMeshPair} from './unlocked-mesh';
import {exportDeviceSource} from './device-source';
import {createSeaSessionClient} from './sea-session-client';
const fail=():never=>{throw Error('Device identity unavailable');};
export type DeviceSession={linkedOidcEnabled?:boolean;recoveryStoreEnabled?:boolean;recoveryRotationEnabled?:boolean;scope:Scope;authorized:boolean;subject:string|null;context:string|null;expiresAt:number|null};
export async function readDeviceSession(signal:AbortSignal=new AbortController().signal):Promise<DeviceSession>{
 const r=await fetch('/api/identity/device/config',{credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',signal});
 if(!r.ok)return fail();return await readBoundedIdentityJson(r,8192,signal) as DeviceSession;
}
/** One mounted account context. Disposal fences every async operation, including
 * PRF, owner checks and IndexedDB commit; private material never enters HTTP. */
export function createDeviceClient(session:DeviceSession,origin:string,onStored:()=>void){
 const abort=new AbortController(),revision=readUnlockedMeshRevision();let disposed=false;
 const current=()=>!disposed&&!abort.signal.aborted&&revision===readUnlockedMeshRevision()&&session.authorized&&!!session.expiresAt&&Date.now()<session.expiresAt;
 const guard=()=>{if(!current())return fail();};
 let protection:Awaited<ReturnType<typeof prepareDeviceProtection>>|undefined,receiverCapability:string|undefined;
 let source:Uint8Array|undefined,sourceIdentity:Identity|undefined;
 async function request(action:string,value:unknown){
  guard();const r=await fetch('/api/identity/device/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Device-Context':session.context??''},body:JSON.stringify(value),credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',signal:abort.signal});guard();
  if(!r.ok||r.redirected)return fail();const body=await readBoundedIdentityJson(r,action==='relay'?710000:4*1024*1024,abort.signal);guard();return {status:r.status,body};
 }
 const authority=createAuthority({scope:session.scope,request:async(action,value)=>(await request(action,value)).body});
 const storage=createDeviceStorage({protection:()=>protection,receiverCapability:()=>receiverCapability,current});
 const relays=new Set<ReturnType<typeof createRelay>>();
 const relay=(role:'receiver'|'sender',id:string,capability:string)=>{
  const value=createRelay({scope:session.scope,role,session:id,capability,request:async call=>await request('relay',call) as {status:number;body:{v:1;result:unknown}}});relays.add(value);return value;
 };
 async function exported(bytes:Uint8Array,identity:Identity){
  guard();const state=await authority.keyringState(identity);guard();const handle=importKeyring(bytes,identity,state);
  try{return {identity,keyring:exportKeyring(handle,state)};}finally{closeKeyring(handle);}
 }
 const adapters:Adapters={scope:session.scope,authority,storage:{lookup:storage.lookup,async commit(value){await storage.commit(value);onStored();}},
  relay({role,request,capability}){guard();if(role==='receiver')receiverCapability=capability;return relay(role,request.session,capability);},
  async prepareProtection(signal){guard();signal.throwIfAborted();const held=await prepareDeviceProtection(new URL(origin).hostname);guard();signal.throwIfAborted();protection=held;},
  async unlock(signal){
   guard();signal.throwIfAborted();
   if(source&&sourceIdentity)return exported(source,sourceIdentity);
   const restored=await restoredKeyringRecords();guard();
   if(restored.length){
    if(restored.length!==1||!same(restored[0].scope,session.scope))return fail();
    const bytes=await openRestoredKeyring(restored[0]);
    try{guard();signal.throwIfAborted();return await exported(bytes,restored[0].identity);}finally{bytes.fill(0);}
   }
   const records=await deviceRecords();guard();if(records.length!==1||!same(records[0].binding.scope,session.scope))return fail();
   const opened=await unlockDeviceRecord(records[0]);
   try{guard();signal.throwIfAborted();return await exported(opened.keyring,records[0].binding.identity);}finally{opened.keyring.fill(0);}
  },
 };
 return {adapters,
  async fetchEncryptedCopy(slot:'current'|'pending'='current'){
   guard();if(!session.recoveryStoreEnabled||!['current','pending'].includes(slot)||(slot==='pending'&&!session.recoveryRotationEnabled))return fail();
   const value=(await request('recovery-read',{slot})).body;
   if(!recoveryView(value)||(value as RecoveryView).row===null)return fail();
   guard();return recoveryRowFile((value as RecoveryView).row!);
  },
  async saveEncryptedCopy(file:Uint8Array){
   guard();if(!session.recoveryStoreEnabled)return fail();
   const row=recoveryFileRow(new Uint8Array(file));
   let opened:Awaited<ReturnType<typeof adapters.unlock>>|undefined;
   try{
    opened=await adapters.unlock(abort.signal);guard();
    const held=opened;
    if(row.principal!==held.identity.principal||row.signingPub!==held.identity.pub||row.epub!==held.identity.epub||row.rotationSeq!==held.identity.rotationSeq)return fail();
    async function withKeyring<T>(use:(handle:ReturnType<typeof importKeyring>,state:Awaited<ReturnType<typeof authority.keyringState>>)=>T){
     const state=await authority.keyringState(held.identity);guard();
     const handle=importKeyring(held.keyring,held.identity,()=>{guard();return state();});
     try{return use(handle,()=>{guard();return state();});}finally{closeKeyring(handle);}
    }
    return await saveRecoveryCopy(row,{current,signal:abort.signal,
     read:async()=>(await request('recovery-read',{slot:'current'})).body,
     authorize:async()=>{await withKeyring(()=>undefined);},
     sign:async view=>withKeyring((handle,state)=>signRecoveryCurrentPut(handle,recoveryRowEnvelope(row),
      {generation:view.generation,head:view.head,row:view.row?recoveryRowEnvelope(view.row):null},state)),
     write:async operation=>(await request('recovery-put',operation)).body});
   }finally{opened?.keyring.fill(0);}
  },
  async commitEncryptedCopy(file:Uint8Array){
   guard();if(!session.recoveryStoreEnabled||!session.recoveryRotationEnabled)return fail();
   const row=recoveryFileRow(new Uint8Array(file));
   let opened:Awaited<ReturnType<typeof adapters.unlock>>|undefined;
   try{
    opened=await adapters.unlock(abort.signal);guard();const held=opened;
    if(row.principal!==held.identity.principal||row.signingPub!==held.identity.pub||row.epub!==held.identity.epub||row.rotationSeq!==held.identity.rotationSeq)return fail();
    async function withKeyring<T>(use:(handle:ReturnType<typeof importKeyring>,state:Awaited<ReturnType<typeof authority.keyringState>>)=>T){
     const state=await authority.keyringState(held.identity);guard();
     const currentState=()=>{guard();return state();},handle=importKeyring(held.keyring,held.identity,currentState);
     try{return use(handle,currentState);}finally{closeKeyring(handle);}
    }
    return await commitRecoveryCopy(row,{current,signal:abort.signal,
     read:async slot=>(await request('recovery-read',{slot})).body,
     authorize:async()=>{await withKeyring(()=>undefined);},
     sign:async view=>{
      if(!view.pending)return fail();const pending=recoveryRowEnvelope(view.pending);
      return withKeyring((handle,state)=>signRecoveryCommit(handle,{generation:view.generation,head:view.head,
       current:view.current?recoveryRowEnvelope(view.current):null,pending},state));
     },
     write:async operation=>(await request('recovery-commit',operation)).body});
   }finally{opened?.keyring.fill(0);}
  },
  async prepareEncryptedCopy(passphrase:Uint8Array,accountHandle:string){
   guard();const phrase=new Uint8Array(passphrase);
   let opened:Awaited<ReturnType<typeof adapters.unlock>>|undefined;
   try{
    opened=await adapters.unlock(abort.signal);guard();
    return await prepareEncryptedRecovery(opened.keyring,opened.identity,phrase,accountHandle,{current,signal:abort.signal,keyringState:identity=>authority.keyringState(identity)});
   }finally{phrase.fill(0);opened?.keyring.fill(0);}
  },
  async restoreCompleteSource(bytes:Uint8Array){
   guard();
   const result=await restoreExistingKeyring(bytes,{scope:session.scope,current,signal:abort.signal,
    keyringState:identity=>authority.keyringState(identity),protect:()=>prepareDeviceProtection(new URL(origin).hostname)});
   guard();onStored();return result.outcome;
  },
  async restoreEncryptedSource(bytes:Uint8Array,passphrase:Uint8Array){
   guard();const result=await restoreEncryptedRecovery(bytes,passphrase,{scope:session.scope,current,signal:abort.signal,
    keyringState:identity=>authority.keyringState(identity),protect:()=>prepareDeviceProtection(new URL(origin).hostname)});
   guard();onStored();return result.outcome;
  },
  async signInRestored(record:RestoredKeyringRecord){
   guard();if(!same(record.scope,session.scope))return fail();const bytes=await openRestoredKeyring(record);
   try{
    guard();const state=await authority.keyringState(record.identity);guard();
    return await activateDeviceKeyring(bytes,record.identity,state,{current,
     signIn:pair=>createSeaSessionClient({base:'/api/identity/sea',origin}).signIn(pair,abort.signal),
     remember:pair=>rememberUnlockedMeshPair(record.address,pair)});
   }finally{bytes.fill(0);}
  },
  /** Existing pair-only installations cannot invent missing retired keys, lanes
   * or content epoch. Admit a complete local material export against the current
   * signed-in identity, with no plaintext persistence or recovery server. */
  async selectCompleteSource(bytes:Uint8Array){
   guard();source?.fill(0);source=undefined;sourceIdentity=undefined;
   const selected=readSingleUnlockedIdentity();if(!selected)return fail();
   const material=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
   const value=await exportDeviceSource(material,selected.pair,{current,keyringState:identity=>authority.keyringState(identity)});
   try{guard();source=value.keyring;sourceIdentity=value.identity;}catch(e){value.keyring.fill(0);throw e;}
  },
  async resume(record:DeviceRecord){
   guard();if(!same(record.binding.scope,session.scope))return fail();const opened=await unlockDeviceRecord(record);let transport:ReturnType<typeof createRelay>|undefined;
   try{guard();transport=relay('receiver',record.binding.session,opened.receiverCapability);return await reconcile(record.binding,storage,transport);}finally{opened.keyring.fill(0);transport?.close();}
  },
  async signIn(record:DeviceRecord){
   guard();if(!same(record.binding.scope,session.scope))return fail();const opened=await unlockDeviceRecord(record);
   try{
    guard();const state=await authority.keyringState(record.binding.identity);guard();
    return await activateDeviceKeyring(opened.keyring,record.binding.identity,state,{current,
     signIn:pair=>createSeaSessionClient({base:'/api/identity/sea',origin}).signIn(pair,abort.signal),
     remember:pair=>rememberUnlockedMeshPair(record.address,pair)});
   }finally{opened.keyring.fill(0);}
  },
  dispose(){disposed=true;abort.abort();authority.close();for(const r of relays)r.close();relays.clear();protection=undefined;receiverCapability=undefined;source?.fill(0);source=undefined;sourceIdentity=undefined;},
 };
}
