import type { ItemReaderWrap } from "sociacl-ids";
import type { SeaPair } from "./identity/sea";
import { sealMediaForReaders, openMediaForReader } from "./media-reader-wraps";
import { MEDIA_STORED_MAX } from "./media-crypto";
import { isCanonicalObjectId } from "./identity/object-id";

export type UploadEntry = { revision: number; tenant: string; object: string; ciphertext: Uint8Array;
  encrypted: Uint8Array; sha256: string; wrap: ItemReaderWrap };
export interface UploadJournal {
  read(signal: AbortSignal): Promise<UploadEntry | null>;
  write(entry: Omit<UploadEntry,"revision">, expected: number|null, signal: AbortSignal): Promise<UploadEntry>;
  remove(expected: number, signal: AbortSignal): Promise<void>;
}
export const uploadDigest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new Uint8Array(bytes))),b=>b.toString(16).padStart(2,"0")).join("");
async function context(tenant:string,object:string) {
  if(!object.startsWith("media_") || !isCanonicalObjectId(object))throw Error("Invalid recovery object");
  return {object,epoch:0,revisionId:await uploadDigest(new TextEncoder().encode(JSON.stringify(["s3rch-upload-recovery-v1",tenant,object])))};
}
/** Local recovery encryption is not a service grant and is never published. */
export async function encryptUploadJournal(value: unknown, tenant:string,object:string,pair:SeaPair) {
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  try {
    if(bytes.length>131072)throw Error("Recovery draft too large");
    const sealed=await sealMediaForReaders(bytes,{tenant,object},await context(tenant,object),
      [{account:pair.pub,pub:pair.pub,identityPub:pair.pub,epub:pair.epub}],[pair.pub]);
    return {encrypted:sealed.bytes,sha256:sealed.sha256,wrap:sealed.wraps[0]};
  } finally {bytes.fill(0);}
}
export async function decryptUploadJournal(entry:UploadEntry,tenant:string,pair:SeaPair):Promise<unknown> {
  if(entry.tenant!==tenant || !(entry.encrypted instanceof Uint8Array) || entry.encrypted.length>131104 ||
      !(entry.ciphertext instanceof Uint8Array) || entry.ciphertext.length>MEDIA_STORED_MAX ||
      !Number.isSafeInteger(entry.revision) || entry.revision<1)throw Error("Invalid recovery draft");
  const bytes=await openMediaForReader(entry.encrypted,entry.sha256,entry.wrap,pair.epriv,pair.epub,
    {tenant,object:entry.object},await context(tenant,entry.object));
  try {return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}
  finally {bytes.fill(0);}
}
/** One pending upload per origin. CAS prevents overwriting another tab's draft. */
export function createUploadJournal(factory:IDBFactory=indexedDB):UploadJournal {
  async function transact<T>(signal:AbortSignal,mode:IDBTransactionMode,work:(store:IDBObjectStore,done:(value:T)=>void,fail:()=>void)=>void):Promise<T> {
    signal.throwIfAborted();
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{
      let finished=false;
      const open=factory.open("s3rch-private-upload-v1",1);
      open.onupgradeneeded=()=>open.result.createObjectStore("pending");
      open.onerror=()=>reject(Error("Recovery storage unavailable"));
      open.onblocked=()=>{finished=true;reject(Error("Close other media tabs and retry"));};
      open.onsuccess=()=>{if(finished){open.result.close();return;}finished=true;if(signal.aborted){open.result.close();reject(signal.reason);}else resolve(open.result);};
    });
    try {
      return await new Promise<T>((resolve,reject)=>{
        const tx=db.transaction("pending",mode);let result:T;
        const abort=()=>{try{tx.abort();}catch{}};
        signal.addEventListener("abort",abort,{once:true});
        const cleanup=()=>signal.removeEventListener("abort",abort);
        tx.oncomplete=()=>{cleanup();signal.aborted?reject(signal.reason):resolve(result);};
        tx.onabort=()=>{cleanup();reject(Error("Recovery storage changed or unavailable"));};
        tx.onerror=()=>{};
        try {signal.throwIfAborted();work(tx.objectStore("pending"),value=>{result=value;},abort);}
        catch{abort();}
      });
    } finally {db.close();}
  }
  return {
    read:signal=>transact(signal,"readonly",(store,done)=>{const q=store.get("upload");q.onsuccess=()=>done(q.result??null);}),
    write:(entry,expected,signal)=>transact(signal,"readwrite",(store,done,fail)=>{
      const q=store.get("upload");q.onsuccess=()=>{
        if((q.result?.revision??null)!==expected){fail();return;}
        const saved={...entry,revision:(expected??0)+1};store.put(saved,"upload");done(saved);
      };
    }),
    remove:(expected,signal)=>transact(signal,"readwrite",(store,done,fail)=>{
      const q=store.get("upload");q.onsuccess=()=>{
        if(q.result?.revision!==expected){fail();return;}store.delete("upload");done(undefined);
      };
    }),
  };
}
