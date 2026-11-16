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
export type DeviceSession={scope:Scope;authorized:boolean;subject:string|null;context:string|null;expiresAt:number|null};
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
   const records=await deviceRecords();guard();if(records.length!==1||!same(records[0].binding.scope,session.scope))return fail();
   const opened=await unlockDeviceRecord(records[0]);
   try{guard();signal.throwIfAborted();return await exported(opened.keyring,records[0].binding.identity);}finally{opened.keyring.fill(0);}
  },
 };
 return {adapters,
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
