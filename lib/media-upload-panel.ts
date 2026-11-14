import { createPrivateMediaBrowser } from "./media-browser-session";
import { subscribeUnlockedMeshPair } from "./identity/unlocked-mesh";
import { readBoundedIdentityJson } from "./identity/bounded-json";
import { isSeaPubkey } from "./identity/forum-check";

export type UploadPanelState={busy:boolean;message:string;allocationConfirmed:boolean;pending:{object:string;name:string}|null};
export function createMediaUploadPanel(tenant:string,changed:(state:UploadPanelState)=>void,options:{fetcher?:typeof fetch;browser?:typeof createPrivateMediaBrowser;clock?:()=>number}={}) {
  const fetcher=options.fetcher??fetch,clock=options.clock??Date.now;
  let key:string|null=null,expires=0,generation=0,disposed=false,controller:AbortController|null=null;
  let expiry:ReturnType<typeof setTimeout>|undefined;
  let state:UploadPanelState={busy:false,message:"",allocationConfirmed:false,pending:null};
  const browser=(options.browser??createPrivateMediaBrowser)(()=>clock()<expires?key:null,fetcher);
  const publish=(next:UploadPanelState)=>{state=next;if(!disposed)changed(next);};
  function reset(){if(expiry)clearTimeout(expiry);expiry=undefined;generation++;controller?.abort();controller=null;key=null;expires=0;publish({busy:false,message:"Upload stopped. Unlock the original identity to resume its encrypted draft.",allocationConfirmed:false,pending:null});}
  const unsubscribe=subscribeUnlockedMeshPair(reset);
  async function operation(work:(signal:AbortSignal,progress:(message:string)=>void,allocated:()=>void)=>Promise<void>) {
    if(disposed||state.busy)return;
    const attempt=++generation;controller=new AbortController();
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]);
    const current=()=>!disposed&&generation===attempt&&!signal.aborted;
    const progress=(message:string)=>{signal.throwIfAborted();if(current())publish({...state,message});};
    publish({...state,busy:true,allocationConfirmed:false,message:"Checking your identity…"});
    try {
      const response=await fetcher("/api/identity/sea/session",{credentials:"same-origin",cache:"no-store",redirect:"error",signal});
      if(!response.ok||response.headers.get("content-type")?.split(";")[0]!=="application/json"){
        await response.body?.cancel().catch(()=>{});throw Error("Identity unavailable");
      }
      const session=await readBoundedIdentityJson(response,4096,signal) as Record<string,unknown>;
      if(!session||session.enabled!==true||typeof session.principal!=="string"||!isSeaPubkey(session.principal)||
          !Number.isSafeInteger(session.expiresAt)||(session.expiresAt as number)<=clock()||(session.expiresAt as number)>clock()+300000)throw Error("Identity unavailable");
      signal.throwIfAborted();if(!current())return;key=session.principal;expires=session.expiresAt as number;
      if(expiry)clearTimeout(expiry);expiry=setTimeout(reset,Math.max(0,expires-clock()));
      await work(signal,progress,()=>{signal.throwIfAborted();if(current())publish({...state,allocationConfirmed:true});});
    } catch {
      if(current())publish({...state,message:"Upload stopped. Your encrypted recovery draft is retained if it was saved. Unlock the same identity and check the pending upload before retrying."});
    } finally {if(!disposed&&attempt===generation){controller=null;key=null;expires=0;publish({...state,busy:false});}}
  }
  return Object.freeze({
    reset,
    inspect:()=>operation(async(signal,progress)=>{const pending=await browser.pendingUpload(tenant,signal);signal.throwIfAborted();publish({...state,pending});progress(pending?"Encrypted draft ready to resume.":"No pending upload in this browser.");}),
    upload:(file:File)=>operation(async(signal,progress,allocated)=>{
      if(!file.size||file.size>63*1024*1024)throw Error("File too large");
      const bytes=new Uint8Array(await file.arrayBuffer());
      try {signal.throwIfAborted();await browser.upload(tenant,{bytes,description:{name:file.name,mediaType:file.type}},signal,progress,allocated);}
      finally {bytes.fill(0);}
      signal.throwIfAborted();publish({...state,pending:null});progress("Uploaded privately. Refresh My media. New files open after the one-hour settlement period.");
    }),
    resume:()=>operation(async(signal,progress,allocated)=>{
      await browser.upload(tenant,undefined,signal,progress,allocated);signal.throwIfAborted();publish({...state,pending:null});
      progress("Upload complete. Refresh My media. New files open after the one-hour settlement period.");
    }),
    discard:()=>{const expectedObject=state.pending?.object;return operation(async(signal,progress)=>{
      if(!expectedObject)throw Error("Inspect the pending upload first");
      await browser.discardUpload(tenant,expectedObject,signal);signal.throwIfAborted();publish({...state,pending:null});
      progress("Local recovery draft discarded. This does not delete uploaded data or release server reservations.");
    });},
    dispose(){disposed=true;unsubscribe();reset();},
  });
}
