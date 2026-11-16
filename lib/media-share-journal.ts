import type { ItemReaderWrap } from "sociacl-ids";
import type { SeaPair } from "./identity/sea";
import { sealMediaForReaders, openMediaForReader } from "./media-reader-wraps";
import { isCanonicalObjectId } from "./identity/object-id";

export type ShareEntry = { revision: number; tenant: string; object: string; 
  encrypted: Uint8Array; sha256: string; wrap: ItemReaderWrap };
export type ShareVersion = number | Pick<ShareEntry,"revision"|"sha256">;
export interface ShareJournal {
  read(signal: AbortSignal): Promise<ShareEntry | null>;
  write(entry: Omit<ShareEntry,"revision">, expected: ShareVersion|null, signal: AbortSignal): Promise<ShareEntry>;
  remove(expected: ShareVersion, signal: AbortSignal): Promise<void>;
}
export const shareDigest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new Uint8Array(bytes))),b=>b.toString(16).padStart(2,"0")).join("");
export type JournalPurpose="share"|"group-consent"|"group-command"|"group-key"|"group-item-grant"|"group-item-epoch"|"group-item-epoch-delivery";
function domain(purpose:JournalPurpose) {
  if(purpose!=="share"&&purpose!=="group-consent"&&purpose!=="group-command"&&purpose!=="group-key"&&purpose!=="group-item-grant"&&purpose!=="group-item-epoch"&&purpose!=="group-item-epoch-delivery")throw Error("Invalid recovery purpose");
  return purpose;
}
async function context(tenant:string,object:string,purpose:JournalPurpose) {
  if(!object.startsWith((purpose==="group-command"||purpose==="group-key")?"set_":"media_") || !isCanonicalObjectId(object))throw Error("Invalid recovery object");
  return {object,epoch:0,revisionId:await shareDigest(new TextEncoder().encode(JSON.stringify([`s3rch-${domain(purpose)}-recovery-v1`,tenant,object])))};
}
/** Local recovery encryption is not a service grant and is never published. */
export async function encryptShareJournal(value: unknown, tenant:string,object:string,pair:SeaPair,purpose:JournalPurpose="share") {
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  try {
    if(bytes.length>524288)throw Error("Recovery draft too large");
    const sealed=await sealMediaForReaders(bytes,{tenant,object},await context(tenant,object,purpose),
      [{account:pair.pub,pub:pair.pub,identityPub:pair.pub,epub:pair.epub}],[pair.pub]);
    return {encrypted:sealed.bytes,sha256:sealed.sha256,wrap:sealed.wraps[0]};
  } finally {bytes.fill(0);}
}
export async function decryptShareJournal(entry:ShareEntry,tenant:string,pair:SeaPair,purpose:JournalPurpose="share"):Promise<unknown> {
  if(entry.tenant!==tenant || !(entry.encrypted instanceof Uint8Array) || entry.encrypted.length>524320 ||
      !Number.isSafeInteger(entry.revision) || entry.revision<1)throw Error("Invalid recovery draft");
  const bytes=await openMediaForReader(entry.encrypted,entry.sha256,entry.wrap,pair.epriv,pair.epub,
    {tenant,object:entry.object},await context(tenant,entry.object,purpose));
  try {return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}
  finally {bytes.fill(0);}
}
function matchesVersion(entry:ShareEntry|undefined,expected:ShareVersion|null) {
  if(expected===null)return entry==null;
  return typeof expected==="number"?entry?.revision===expected:
    entry?.revision===expected.revision&&entry?.sha256===expected.sha256;
}
/** One pending share per origin. CAS prevents overwriting another tab's draft. */
export function createShareJournal(factory:IDBFactory=indexedDB,purpose:JournalPurpose="share"):ShareJournal {
  const namespace=`s3rch-private-${domain(purpose)}-v1`;
  async function transact<T>(signal:AbortSignal,mode:IDBTransactionMode,work:(store:IDBObjectStore,done:(value:T)=>void,fail:()=>void)=>void):Promise<T> {
    signal.throwIfAborted();
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{
      let finished=false;
      const open=factory.open(namespace,1);
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
    read:signal=>transact(signal,"readonly",(store,done)=>{const q=store.get("share");q.onsuccess=()=>done(q.result??null);}),
    write:(entry,expected,signal)=>transact(signal,"readwrite",(store,done,fail)=>{
      const q=store.get("share");q.onsuccess=()=>{
        if(!matchesVersion(q.result,expected)){fail();return;}
        const saved={...entry,revision:(q.result?.revision??0)+1};store.put(saved,"share");done(saved);
      };
    }),
    remove:(expected,signal)=>transact(signal,"readwrite",(store,done,fail)=>{
      const q=store.get("share");q.onsuccess=()=>{
        if(!matchesVersion(q.result,expected)){fail();return;}store.delete("share");done(undefined);
      };
    }),
  };
}
