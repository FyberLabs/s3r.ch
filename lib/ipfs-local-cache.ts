/** Opt-in local ciphertext retention only. Never pins, fetches or reprovides. */
import { IPFS_MEDIA_BLOCK_BYTES, rawMediaBlockCid } from "./ipfs-media-blocks";
const DB = "s3rch-ipfs-ciphertext-v1", STORE = "blocks", CLOCK = "clock";
const MAX_BYTES = 64 * IPFS_MEDIA_BLOCK_BYTES, MAX_ENTRIES = 64, MAX_TTL = 86400000;
type CachedRead = {bytes:Uint8Array; expires:number; checkedAt:number};
type Row = {id:string; scope:string; cid:string; bytes:Uint8Array; created:number; expires:number};
export type LocalCiphertextPolicy = Readonly<{enabled:boolean; maxBytes:number; maxEntries:number; ttlMs:number}>;
const unavailable = () => Error("Local ciphertext cache unavailable");
function open(factory:IDBFactory):Promise<IDBDatabase> {
 return new Promise((resolve,reject)=>{
  let done=false;
  const fail=()=>{if(!done){done=true;clearTimeout(timer);reject(unavailable());}};
  const timer=setTimeout(fail,2000), request=factory.open(DB,1);
  request.onupgradeneeded=()=>{request.result.createObjectStore(STORE,{keyPath:"id"});request.result.createObjectStore(CLOCK);};
  request.onerror=fail;request.onblocked=fail;
  request.onsuccess=()=>{if(done){request.result.close();return;}done=true;clearTimeout(timer);resolve(request.result);};
 });
}
/** scope is an opaque, non-secret owner/session partition chosen by native code.
 * current() must include explicit retention consent and current grant authority.
 * Policy is captured once; close old instances when policy/identity changes. */
export function createLocalCiphertextCache(input:{scope:string; policy:LocalCiphertextPolicy; current:()=>boolean; factory?:IDBFactory; now?:()=>number}) {
 const scope=input.scope, policy=Object.freeze({...input.policy}), factory=input.factory??globalThis.indexedDB, now=input.now??Date.now;
 if(!/^[a-f0-9]{64}$/.test(scope) || typeof policy.enabled!=="boolean" ||
  !Number.isSafeInteger(policy.maxBytes)||policy.maxBytes<1||policy.maxBytes>MAX_BYTES ||
  !Number.isSafeInteger(policy.maxEntries)||policy.maxEntries<1||policy.maxEntries>MAX_ENTRIES ||
  !Number.isSafeInteger(policy.ttlMs)||policy.ttlMs<1||policy.ttlMs>MAX_TTL) throw unavailable();
 let closed=false, pending=0;
 const running=new Set<AbortController>();
 const current=()=>{try{return !closed&&policy.enabled&&input.current()===true;}catch{return false;}};
 function guard(signal?:AbortSignal){if(!current()||signal?.aborted)throw unavailable();}
 async function transact(kind:"get"|"put"|"clear"|"evict",cid:string,bytes?:Uint8Array,signal?:AbortSignal,cids:readonly string[]=[]):Promise<CachedRead|null> {
  if(kind!=="clear"&&kind!=="evict")guard(signal);
  if(signal?.aborted||running.size>=4)throw unavailable();
  const controller=new AbortController();running.add(controller);
  const abort=()=>controller.abort();signal?.addEventListener("abort",abort,{once:true});
  let db:IDBDatabase|undefined;
  try {
   db=await open(factory);if(controller.signal.aborted)throw unavailable();
   return await new Promise((resolve,reject)=>{
    const tx=db!.transaction([STORE,CLOCK],"readwrite"), store=tx.objectStore(STORE), clock=tx.objectStore(CLOCK);
    let result:CachedRead|null=null,count=0,total=0,seen=0,existing:Row|undefined;
    const cancel=()=>{try{tx.abort();}catch{/* Already complete. */}};
    controller.signal.addEventListener("abort",cancel,{once:true});const timer=setTimeout(cancel,2000);
    const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener("abort",cancel);};
    tx.onabort=()=>{finish();reject(unavailable());};tx.oncomplete=()=>{finish();resolve(result);};
    // Exact-key deletes are atomic and need neither a readable ledger nor current authority.
    if(kind==="evict"){for(const selected of cids)store.delete(scope+":"+selected);return;}
    const readClock=clock.get("last");
    readClock.onsuccess=()=>{try {
     const at=now();
     if(kind!=="clear"&&(!Number.isSafeInteger(at)||at<0||at>Number.MAX_SAFE_INTEGER-MAX_TTL||
       (readClock.result!==undefined&&(!Number.isSafeInteger(readClock.result)||at<readClock.result))))throw unavailable();
     if(kind!=="clear")guard(controller.signal);
     if(kind!=="clear")clock.put(at,"last");
     const cursor=store.openCursor();
     cursor.onsuccess=()=>{try {
      if(kind!=="clear")guard(controller.signal);
      const entry=cursor.result;
      if(entry) {
       if(++seen>MAX_ENTRIES)throw unavailable();
       const row=entry.value as Row;
       if(kind==="clear") {if(row?.scope===scope)entry.delete();entry.continue();return;}
       if(typeof row?.scope!=="string"||typeof row.cid!=="string"||row.id!==row.scope+":"+row.cid||!(row.bytes instanceof Uint8Array)||row.bytes.length<1||row.bytes.length>IPFS_MEDIA_BLOCK_BYTES||
         !Number.isSafeInteger(row.created)||!Number.isSafeInteger(row.expires)||row.created>at||row.expires<=row.created||row.expires-row.created>MAX_TTL)throw unavailable();
       if(row.expires<=at)entry.delete();
       else {count++;total+=row.bytes.length;if(row.id===scope+":"+cid)existing=row;}
       entry.continue();return;
      }
      if(total>MAX_BYTES||count>MAX_ENTRIES)throw unavailable();
      if(kind==="get"&&existing)result={bytes:new Uint8Array(existing.bytes),expires:existing.expires,checkedAt:at};
      if(kind==="put") {
       if(!bytes)throw unavailable();
       const size=bytes.length;
       if(total-(existing?.bytes.length??0)+size>policy.maxBytes||count+(existing?0:1)>policy.maxEntries)throw unavailable();
       // A retry never extends retention for an existing CID.
       store.put({id:scope+":"+cid,scope,cid,bytes,created:existing?.created??at,expires:Math.min(existing?.expires??at+policy.ttlMs,at+policy.ttlMs)} satisfies Row);
      }
     }catch{cancel();}};
    }catch{cancel();}};
   });
  } finally {db?.close();signal?.removeEventListener("abort",abort);running.delete(controller);}
 }
 return Object.freeze({
  close(){closed=true;for(const controller of running)controller.abort();},
  async put(cid:string,block:Uint8Array,signal?:AbortSignal):Promise<void>{
   guard(signal);if(pending>=4)throw unavailable();pending++;
   try {
   if(!(block instanceof Uint8Array)||block.length<1||block.length>IPFS_MEDIA_BLOCK_BYTES||block.length>policy.maxBytes)throw unavailable();
   const bytes=new Uint8Array(block);if(await rawMediaBlockCid(bytes)!==cid)throw unavailable();guard(signal);
   await transact("put",cid,bytes,signal);guard(signal);
   }finally{pending--;}
  },
  async get(cid:string,signal?:AbortSignal):Promise<Uint8Array|null>{
   guard(signal);if(pending>=4)throw unavailable();pending++;
   try {
   if(typeof cid!=="string"||!/^b[a-z2-7]{58}$/.test(cid))throw unavailable();
   const result=await transact("get",cid,undefined,signal);
   if(result&&await rawMediaBlockCid(result.bytes)!==cid)throw unavailable();guard(signal);
   if(!result)return null;
   const at=now();if(!Number.isSafeInteger(at)||at<result.checkedAt)throw unavailable();
   return at>=result.expires?null:result.bytes;
   }finally{pending--;}
  },
  /** Delete selected local copies atomically. No grant required; no remote erasure claim. */
  async evict(cids:readonly string[],signal?:AbortSignal):Promise<void>{
   if(!Array.isArray(cids)||cids.length<1||cids.length>MAX_ENTRIES||pending>=4)throw unavailable();
   const selected=[...cids];
   if(selected.some(cid=>typeof cid!=="string"||!/^bafkrei[a-z2-7]{52}$/.test(cid)))throw unavailable();
   pending++;
   try{await transact("evict","",undefined,signal,selected);}finally{pending--;}
  },
  // Erasure remains available after opt-out/close; never requires a grant.
  async clear():Promise<void>{
   if(pending>=4)throw unavailable();pending++;
   try{await transact("clear","");}finally{pending--;}
  },
 });
}
