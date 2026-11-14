import { createUploadJournal } from "./media-upload-journal";
import { uploadMedia, pendingMediaUpload, discardMediaUpload } from "./media-upload";
import type { MediaFileDescription } from "./media-file";
import type { UnverifiedObjectRecord } from "./identity/forum-object-record";
import { createPrivateMediaOwner } from "./media-owner-client";
import { createPrivateMediaReader } from "./media-wrap-client";
import { readSingleUnlockedIdentity, subscribeUnlockedMeshPair } from "./identity/unlocked-mesh";
import type { SeaPair } from "./identity/sea";
import type { ItemReaderWrap } from "sociacl-ids";
import type { MediaCiphertextReference } from "./media-client";

/** Browser memory only. A held SEA key is possession, never an object grant.
 * sessionKey must come from the current authenticated SEA session. */
export function createPrivateMediaBrowser(sessionKey: () => string | null, fetcher: typeof fetch = fetch) {
  async function run<T>(operation: (pair: SeaPair, fetcher: typeof fetch, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal, discard?: (result: T) => void): Promise<T> {
    const selected=readSingleUnlockedIdentity();
    if(!selected || selected.pair.pub!==sessionKey())throw Error("Unlock the signed-in media identity");
    const stopped=new AbortController();
    const deadline=AbortSignal.any([stopped.signal,...(signal?[signal]:[]),AbortSignal.timeout(120000)]);
    const check=()=>{
      const current=readSingleUnlockedIdentity();
      if(!current || current.revision!==selected.revision || current.pair.pub!==selected.pair.pub ||
          sessionKey()!==selected.pair.pub)stopped.abort();
      deadline.throwIfAborted();
    };
    // Listeners must not throw into the shared identity event dispatcher.
    const unsubscribe=subscribeUnlockedMeshPair(()=>{stopped.abort();});
    const guardedFetch: typeof fetch=async(url,init)=>{
      check();
      const response=await fetcher(url,{...init,signal:AbortSignal.any([deadline,...(init?.signal?[init.signal]:[])])});
      try {check();return response;}
      catch(error){await response.body?.cancel().catch(()=>{});throw error;}
    };
    try {
      check();const result=await operation(selected.pair,guardedFetch,deadline);
      try {check();return result;}catch(error){discard?.(result);throw error;}
    } finally {unsubscribe();stopped.abort();}
  }
  async function signed<T>(operation: (client: ReturnType<typeof createPrivateMediaOwner>, scalar: Uint8Array, signal: AbortSignal)=>Promise<T>,signal?:AbortSignal) {
    return run(async(pair,transport,deadline)=>{
      if(!/^[A-Za-z0-9_-]{43}$/.test(pair.priv))throw Error("Invalid media signing key");
      const scalar=Uint8Array.from(atob(pair.priv.replace(/-/g,"+").replace(/_/g,"/")+"="),c=>c.charCodeAt(0));
      try {
        if(scalar.length!==32 || btoa(String.fromCharCode(...scalar)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")!==pair.priv)
          throw Error("Invalid media signing key");
        return await operation(createPrivateMediaOwner(transport),scalar,deadline);
      } finally {scalar.fill(0);}
    },signal);
  }
  async function locked<T>(work:()=>Promise<T>) {
    if (typeof navigator === "undefined" || !navigator.locks) throw Error("This browser cannot safely resume uploads");
    return navigator.locks.request("s3rch-private-upload-v1", {mode:"exclusive",ifAvailable:true}, lock=>{
      if(!lock)throw Error("An upload is active in another tab");return work();
    });
  }
  return Object.freeze({
    upload(tenant:string,file?:{bytes:Uint8Array;description:MediaFileDescription},signal?:AbortSignal,progress?:(message:string)=>void){
      return locked(()=>run((pair,transport,deadline)=>uploadMedia({tenant,pair,fetcher:transport,signal:deadline,journal:createUploadJournal(),file,progress}),signal));
    },
    pendingUpload(tenant:string,signal?:AbortSignal){
      return run((pair,_transport,deadline)=>pendingMediaUpload(createUploadJournal(),tenant,pair,deadline),signal);
    },
    discardUpload(tenant:string,expectedObject:string,signal?:AbortSignal){
      return locked(()=>run((pair,_transport,deadline)=>discardMediaUpload(createUploadJournal(),tenant,expectedObject,pair,deadline),signal));
    },
    allocate(record:UnverifiedObjectRecord,signal?:AbortSignal){
      return run((_pair,transport,deadline)=>createPrivateMediaOwner(transport).allocate(record,deadline),signal);
    },
    catalog(page:number,signal?:AbortSignal){
      return run((_pair,transport,deadline)=>createPrivateMediaOwner(transport).catalog(page,deadline),signal);
    },
    recipients(object:string,owner:string,signal?:AbortSignal){
      return run((_pair,transport,deadline)=>createPrivateMediaOwner(transport).recipients(object,owner,deadline),signal);
    },
    cancel(object:string,reader:string,signal?:AbortSignal){
      return signed((client,key,deadline)=>client.cancel(object,reader,key,deadline),signal);
    },
    grant(object:string,owner:string,draft:unknown,signal?:AbortSignal){
      return signed((client,key,deadline)=>client.grant(object,owner,draft,key,deadline),signal);
    },
    initialEpoch(object:string,owner:string,draft:unknown,signal?:AbortSignal){
      return signed((client,key,deadline)=>client.initialEpoch(object,owner,draft,key,deadline),signal);
    },
    epoch(object:string,owner:string,draft:unknown,finalization:unknown,signal?:AbortSignal){
      return signed((client,key,deadline)=>client.epoch(object,owner,draft,finalization,key,deadline),signal);
    },
    status(object:string,reader:string,signal?:AbortSignal){
      return signed((client,key,deadline)=>client.status(object,reader,key,deadline),signal);
    },
    publishWrap(object:string,owner:string,reader:string,wrap:ItemReaderWrap,reference:MediaCiphertextReference,signal?:AbortSignal){
      return run((_pair,transport,deadline)=>createPrivateMediaOwner(transport).publishWrap(object,owner,reader,wrap,reference,deadline),signal);
    },
    open(object:string,tenant:string,signal?:AbortSignal){
      return run((pair,transport,deadline)=>createPrivateMediaReader(transport).open(object,tenant,pair.epriv,pair.epub,deadline),signal,
        result=>result.bytes.fill(0));
    },
  });
}
