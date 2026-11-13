import { createPrivateMediaBrowser } from "./media-browser-session";
import { readBoundedIdentityJson } from "./identity/bounded-json";
import { isSeaPubkey } from "./identity/forum-check";
import { subscribeUnlockedMeshPair } from "./identity/unlocked-mesh";

export type MediaLibraryState = Readonly<{ busy: boolean; objects: readonly string[]; page: number;
  nextPage: number | null; loaded: boolean; message: string;
  audience: Readonly<{object:string;readers:readonly string[]}> | null;
  preview: Readonly<{ url: string; name: string; mediaType: string }> | null }>;
const empty = (): MediaLibraryState => ({busy:false,objects:[],page:0,nextPage:null,loaded:false,message:"",preview:null,audience:null});

/** Private, in-memory navigation. Never persists catalog entries or plaintext. */
export function createMediaLibrary(changed: (state: MediaLibraryState)=>void, options: {
  fetcher?: typeof fetch; clock?: ()=>number;
  browser?: typeof createPrivateMediaBrowser;
  makeUrl?: (blob: Blob)=>string; revokeUrl?: (url: string)=>void;
} = {}) {
  const fetcher=options.fetcher ?? fetch, clock=options.clock ?? Date.now;
  const makeUrl=options.makeUrl ?? URL.createObjectURL, revokeUrl=options.revokeUrl ?? URL.revokeObjectURL;
  let state=empty(), key: string|null=null, owner: string|null=null, expires=0, generation=0, disposed=false;
  let pending: AbortController|null=null, expiry: ReturnType<typeof setTimeout>|undefined;
  const browser=(options.browser ?? createPrivateMediaBrowser)(()=>clock()<expires ? key : null,fetcher);
  function publish(next: MediaLibraryState) { state=Object.freeze(next); if(!disposed)changed(state); }
  function clearPreview() { if(state.preview)revokeUrl(state.preview.url); }
  function reset(message="") {
    generation++;pending?.abort();pending=null;key=null;owner=null;expires=0;
    if(expiry)clearTimeout(expiry);expiry=undefined;clearPreview();publish({...empty(),message});
  }
  const unsubscribe=subscribeUnlockedMeshPair(()=>reset("Identity changed. Refresh your media."));
  async function session(signal: AbortSignal) {
    const response=await fetcher("/api/identity/sea/session",{credentials:"same-origin",cache:"no-store",redirect:"error",signal});
    if(!response.ok || response.headers.get("content-type")?.split(";")[0]!=="application/json") {
      await response.body?.cancel().catch(()=>{});throw Error("Sign in with your saved identity to view media.");
    }
    const value=await readBoundedIdentityJson(response,4096,signal) as Record<string,unknown>|null;
    signal.throwIfAborted();
    if(!value || value.enabled!==true || typeof value.principal!=="string" || !isSeaPubkey(value.principal) ||
        !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number)<=clock() ||
        (value.expiresAt as number)>clock()+300000)throw Error("Sign in with your saved identity to view media.");
    key=value.principal;expires=value.expiresAt as number;
    if(expiry)clearTimeout(expiry);
    expiry=setTimeout(()=>reset("Your identity session expired. Sign in and refresh your media."),Math.max(0,expires-clock()));
  }
  async function operation(work: (signal: AbortSignal, current: ()=>boolean)=>Promise<void>) {
    if(disposed || state.busy)return;
    const attempt=++generation, controller=new AbortController();pending=controller;
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]);
    const current=()=>!disposed && attempt===generation && !signal.aborted && clock()<expires;
    clearPreview();publish({...state,busy:true,message:"",preview:null});
    try {
      await session(signal);
      if(!current())return;
      await work(signal,current);
    } catch {
      if(!disposed && attempt===generation)reset("Media is unavailable. Check your identity session and access, then retry.");
    } finally {
      if(!disposed && attempt===generation){pending=null;publish({...state,busy:false});}
    }
  }
  return Object.freeze({
    reset,
    load(page=0) {
      return operation(async(signal,current)=>{
        const catalog=await browser.catalog(page,signal);
        if(current()){owner=catalog.principal;publish({...state,objects:catalog.objects,page,nextPage:catalog.nextPage,loaded:true,audience:null});}
      });
    },
    recipients(object: string) {
      if(!state.objects.includes(object) || !owner)return Promise.resolve();
      const principal=owner;
      return operation(async(signal,current)=>{
        const readers=await browser.recipients(object,principal,signal);
        if(current())publish({...state,audience:{object,readers}});
      });
    },
    cancel(object: string, reader: string) {
      if(state.audience?.object!==object || !state.audience.readers.includes(reader))return Promise.resolve();
      return operation(async(signal,current)=>{
        await browser.cancel(object,reader,signal);
        if(current())publish({...state,audience:null,message:"Sharing stopped for this identity. Copies already saved cannot be removed."});
      });
    },
    open(object: string, tenant: string) {
      if(!state.objects.includes(object))return Promise.resolve();
      return operation(async(signal,current)=>{
        const file=await browser.open(object,tenant,signal);
        try {
          if(!current())return;
          if(!/^image\/(png|jpeg|gif|webp|avif)$/.test(file.description.mediaType)) {
            publish({...state,message:"This file is not an image. Image previews are available here."});return;
          }
          const url=makeUrl(new Blob([new Uint8Array(file.bytes)],{type:file.description.mediaType}));
          if(!current()){revokeUrl(url);return;}
          publish({...state,preview:{url,...file.description}});
        } finally {file.bytes.fill(0);}
      });
    },
    dispose() { if(disposed)return;disposed=true;unsubscribe();reset(); },
  });
}
