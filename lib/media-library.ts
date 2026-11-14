import { isCanonicalObjectId } from "./identity/object-id";
import type { MediaCleanupItem } from "./media-catalog";
import type { MediaDeletionIntent } from "./media-deletion";
import { readMemePngTags } from "./meme-png-tags";
import { mediaPreviewKind } from "./media-preview";
import { createPrivateMediaBrowser } from "./media-browser-session";
import { readBoundedIdentityJson } from "./identity/bounded-json";
import { isSeaPubkey } from "./identity/forum-check";
import { subscribeUnlockedMeshPair } from "./identity/unlocked-mesh";

class SessionUnavailable extends Error {}

export type MediaLibraryState = Readonly<{ busy: boolean; objects: readonly string[]; page: number;
  nextPage: number | null; loaded: boolean; message: string;
  sharing: Readonly<{object:string;reader:string;token:string;remove?:boolean}> | null;
  granted: Readonly<{objects:readonly string[];page:number;nextPage:number|null}> | null;
  cleanup: Readonly<{objects:readonly MediaCleanupItem[];page:number;nextPage:number|null}> | null;
  deletion: Readonly<{object:string;prepared:boolean}> | null;
  audience: Readonly<{object:string;readers:readonly string[]}> | null;
  preview: Readonly<{ url: string; name: string; mediaType: string; tags?:readonly string[] }> | null }>;
const empty = (): MediaLibraryState => ({busy:false,objects:[],page:0,nextPage:null,loaded:false,message:"",preview:null,audience:null,deletion:null,cleanup:null,granted:null,sharing:null});

/** Private, in-memory navigation. Never persists catalog entries or plaintext. */
export function createMediaLibrary(changed: (state: MediaLibraryState)=>void, options: {
  fetcher?: typeof fetch; clock?: ()=>number;
  browser?: typeof createPrivateMediaBrowser;
  makeUrl?: (blob: Blob)=>string; revokeUrl?: (url: string)=>void;
} = {}) {
  const fetcher=options.fetcher ?? fetch, clock=options.clock ?? Date.now;
  const makeUrl=options.makeUrl ?? URL.createObjectURL, revokeUrl=options.revokeUrl ?? URL.revokeObjectURL;
  let state=empty(), key: string|null=null, owner: string|null=null, expires=0, generation=0, disposed=false;
  let deletionIntent: MediaDeletionIntent|null=null;
  let pending: AbortController|null=null, expiry: ReturnType<typeof setTimeout>|undefined;
  const browser=(options.browser ?? createPrivateMediaBrowser)(()=>clock()<expires ? key : null,fetcher);
  function publish(next: MediaLibraryState) { state=Object.freeze(next); if(!disposed)changed(state); }
  function clearPreview() { if(state.preview)revokeUrl(state.preview.url); }
  function reset(message="") {
    generation++;deletionIntent=null;pending?.abort();pending=null;key=null;owner=null;expires=0;
    if(expiry)clearTimeout(expiry);expiry=undefined;clearPreview();publish({...empty(),message});
  }
  const unsubscribe=subscribeUnlockedMeshPair(()=>reset("Identity changed. Refresh your media."));
  async function session(signal: AbortSignal) {
    let response:Response;
    try {response=await fetcher("/api/identity/sea/session",{credentials:"same-origin",cache:"no-store",redirect:"error",signal});}
    catch {throw new SessionUnavailable();}
    if(response.status>=500 || response.status===429) {
      await response.body?.cancel().catch(()=>{});throw new SessionUnavailable();
    }
    if(!response.ok || response.headers.get("content-type")?.split(";")[0]!=="application/json") {
      await response.body?.cancel().catch(()=>{});throw Error("Sign in with your saved identity to view media.");
    }
    let value:Record<string,unknown>|null;
    try {value=await readBoundedIdentityJson(response,4096,signal) as Record<string,unknown>|null;}
    catch {throw new SessionUnavailable();}
    signal.throwIfAborted();
    if(!value || value.enabled!==true || typeof value.principal!=="string" || !isSeaPubkey(value.principal) ||
        !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number)<=clock() ||
        (value.expiresAt as number)>clock()+300000)throw Error("Sign in with your saved identity to view media.");
    if(key && key!==value.principal)throw Error("Identity changed");
    key=value.principal;expires=value.expiresAt as number;
    if(expiry)clearTimeout(expiry);
    expiry=setTimeout(()=>reset("Your identity session expired. Sign in and refresh your media."),Math.max(0,expires-clock()));
  }
  async function operation(work: (signal: AbortSignal, current: ()=>boolean)=>Promise<void>, failed?: ()=>void) {
    if(disposed || state.busy)return;
    const attempt=++generation, controller=new AbortController();pending=controller;
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]);
    const current=()=>!disposed && attempt===generation && !signal.aborted && clock()<expires;
    clearPreview();publish({...state,busy:true,message:"",preview:null});
    let started=false;
    try {
      await session(signal);
      if(!current())return;
      started=true;await work(signal,current);
    } catch(error) {
      if(!disposed && attempt===generation) {
        if((started || (error instanceof SessionUnavailable && deletionIntent)) && current() && failed)failed();
        else reset("Media is unavailable. Check your identity session and access, then retry.");
      }
    } finally {
      if(!disposed && attempt===generation){pending=null;publish({...state,busy:false});}
    }
  }
  function openAuthorized(object: string, tenant: string) {
      return operation(async(signal,current)=>{
        if(state.objects.includes(object)) {
          if (!owner) throw Error("Media owner unavailable");
          await browser.status(object,owner,signal);
        }
        const file=await browser.open(object,tenant,signal);
        try {
          if(!current())return;
          if(!mediaPreviewKind(file.description.mediaType)) {
            publish({...state,message:"This file format cannot be previewed."});return;
          }
          const url=makeUrl(new Blob([new Uint8Array(file.bytes)],{type:file.description.mediaType}));
          if(!current()){revokeUrl(url);return;}
          publish({...state,preview:{url,...file.description,...(file.description.mediaType==="image/png"?{tags:readMemePngTags(file.bytes)}:{})}});
        } finally {file.bytes.fill(0);}
      });
  }
  return Object.freeze({
    reset,
    requestDeletion(object:string) {
      if(disposed || state.busy || state.deletion || !owner || !state.objects.includes(object))return;
      clearPreview();deletionIntent=null;
      publish({...state,preview:null,audience:null,message:"",deletion:{object,prepared:false}});
    },
    cancelDeletion() {
      if(disposed || state.busy)return;
      deletionIntent=null;publish({...state,deletion:null,message:""});
    },
    confirmDeletion(tenant:string) {
      const selected=state.deletion, principal=owner;
      if(!selected || !principal)return Promise.resolve();
      return operation(async(signal,current)=>{
        if(!deletionIntent) {
          const intent=await browser.prepareDeletion(tenant,selected.object,principal,signal);
          if(!current())return;
          deletionIntent=intent;publish({...state,deletion:{object:selected.object,prepared:true}});
        }
        await browser.submitDeletion(deletionIntent,signal);
        if(current()) {
          deletionIntent=null;
          publish({...state,objects:state.objects.filter(object=>object!==selected.object),deletion:null,audience:null,
            message:"Deletion accepted. Access stopped; storage cleanup is pending."});
        }
      },()=>publish({...state,message:deletionIntent
        ? "Deletion could not be confirmed. Retry sends the same request. Closing does not undo an accepted deletion."
        : "Deletion could not be prepared. Check your access and retry."}));
    },
    loadCleanup(page=0) {
      if(state.deletion)return Promise.resolve();
      return operation(async(signal,current)=>{
        const catalog=await browser.cleanupCatalog(page,signal);
        if(current())publish({...state,cleanup:{objects:catalog.objects,page,nextPage:catalog.nextPage},audience:null});
      });
    },
    cleanup(object:string,command:string) {
      if(state.deletion || !state.cleanup?.objects.some(item=>item.object===object && item.command===command))return Promise.resolve();
      return operation(async(signal,current)=>{
        await browser.cleanup(object,command,signal);
        if(current() && state.cleanup)publish({...state,cleanup:{...state.cleanup,
          objects:state.cleanup.objects.filter(item=>item.object!==object)},message:"Storage cleanup confirmed."});
      },()=>publish({...state,message:"Storage cleanup could not be confirmed. Refresh pending cleanup or retry."}));
    },
    load(page=0) {
      if(state.deletion)return Promise.resolve();
      return operation(async(signal,current)=>{
        const catalog=await browser.catalog(page,signal);
        if(current()){owner=catalog.principal;publish({...state,objects:catalog.objects,page,nextPage:catalog.nextPage,loaded:true,audience:null});}
      });
    },
    loadGranted(page=0) {
      if(state.deletion)return Promise.resolve();
      return operation(async(signal,current)=>{
        const catalog=await browser.grantedCatalog(page,signal);
        if(current())publish({...state,granted:{objects:catalog.objects,page,nextPage:catalog.nextPage},audience:null});
      });
    },
    inspectSharing(tenant:string) {
      if(state.deletion)return Promise.resolve();
      return operation(async(signal,current)=>{
        const sharing=await browser.pendingShare(tenant,signal);
        if(current())publish({...state,sharing,message:sharing?"A sharing change is saved. Resume to confirm it.":"No pending sharing change."});
      });
    },
    share(tenant:string,object:string,reader:string) {
      if(state.deletion||state.sharing||state.audience?.object!==object||!state.objects.includes(object)||!owner||!isSeaPubkey(reader)||reader===owner)return Promise.resolve();
      const principal=owner;
      return operation(async(signal,current)=>{
        const result=await browser.share(tenant,{object,owner:principal,reader},signal);
        if(current())publish({...state,audience:null,sharing:result.pending?{object,reader,token:result.token,...(result.remove?{remove:true}:{})}:null,
          message:result.pending?"Sharing is saved but not yet confirmed. Resume after the access update settles.":"Sharing confirmed. Recipient access uses fresh authorization."});
      },()=>publish({...state,sharing:null,message:"Sharing could not be confirmed. Check saved sharing before retrying; accepted changes are not undone."}));
    },
    resumeSharing(tenant:string) {
      if(state.deletion||!state.sharing)return Promise.resolve();
      const selected={...state.sharing};
      return operation(async(signal,current)=>{
        const result=await browser.resumeShare(tenant,selected,signal);
        if(current())publish({...state,audience:null,sharing:result.pending?{object:result.object,reader:result.reader,token:result.token,...(result.remove?{remove:true}:{})}:null,
          message:result.pending?"Sharing is still pending. Future access times and settlement can delay completion.":"Sharing confirmed."});
      },()=>publish({...state,message:"Sharing could not be confirmed. The saved change is retained; check access and retry."}));
    },
    abandonSharing(tenant:string) {
      if(state.deletion||!state.sharing)return Promise.resolve();
      const selected={...state.sharing};
      return operation(async(signal,current)=>{
        await browser.abandonShare(tenant,selected,signal);
        if(current())publish({...state,sharing:null,message:"Local sharing recovery forgotten. Accepted access changes were not undone; inspect this file's sharing."});
      },()=>publish({...state,message:"Saved sharing changed or could not be removed. Inspect it again before forgetting it."}));
    },
    recipients(object: string) {
      if(state.deletion || !state.objects.includes(object) || !owner)return Promise.resolve();
      const principal=owner;
      return operation(async(signal,current)=>{
        const readers=(await browser.recipients(object,principal,signal)).filter(reader=>reader!==principal);
        if(current())publish({...state,audience:{object,readers}});
      });
    },
    unshare(tenant:string,object:string,reader:string) {
      if(state.deletion||state.sharing||state.audience?.object!==object||!state.audience.readers.includes(reader)||!owner)return Promise.resolve();
      const principal=owner;
      return operation(async(signal,current)=>{
        const result=await browser.share(tenant,{object,owner:principal,reader,remove:true},signal);
        if(current())publish({...state,audience:null,sharing:result.pending?{object,reader,token:result.token,remove:true}:null,
          message:result.pending?"Removal is saved. Resume to finish the remaining readers' access update.":"Sharing stopped for this identity. Copies already saved cannot be removed."});
      },()=>publish({...state,sharing:null,message:"Removal could not be confirmed. Check saved sharing before retrying; accepted changes are not undone."}));
    },
    cancel(object: string, reader: string) {
      if(state.deletion || state.audience?.object!==object || !state.audience.readers.includes(reader))return Promise.resolve();
      return operation(async(signal,current)=>{
        await browser.cancel(object,reader,signal);
        if(current())publish({...state,audience:null,message:"Sharing stopped for this identity. Copies already saved cannot be removed."});
      });
    },
    open(object: string, tenant: string) {
      if(state.deletion || (!state.objects.includes(object) && !state.granted?.objects.includes(object)))return Promise.resolve();
      return openAuthorized(object,tenant);
    },
    /** A signed room reference is a locator, never read authority. The browser's
     * existing read-wrap path checks current access before fetching ciphertext. */
    openReference(object: string, tenant: string) {
      if(state.deletion || !object.startsWith("media_") || !isCanonicalObjectId(object))return Promise.resolve();
      return openAuthorized(object,tenant);
    },
    dispose() { if(disposed)return;disposed=true;unsubscribe();reset(); },
  });
}
