"use client";

import { useEffect, useRef, useState } from "react";
import { createMediaLibrary, type MediaLibraryState } from "@/lib/media-library";
import { IdentityBar } from "./IdentityBar";
import { PrivateMediaUpload } from "./PrivateMediaUpload";
import { PrivateMediaPreview } from "./PrivateMediaPreview";

export function PrivateMediaLibrary({tenant}: {tenant: string|null}) {
  const [state,setState]=useState<MediaLibraryState>({busy:false,objects:[],page:0,nextPage:null,loaded:false,message:"",preview:null,audience:null});
  const library=useRef<ReturnType<typeof createMediaLibrary>|null>(null);
  useEffect(()=>{
    const current=createMediaLibrary(setState);library.current=current;
    const changed=()=>current.reset("Identity changed. Refresh your media.");
    window.addEventListener("s3rch-session-changed",changed);
    const hidden=()=>{if(document.visibilityState==="hidden")current.reset();};
    document.addEventListener("visibilitychange",hidden);
    return ()=>{window.removeEventListener("s3rch-session-changed",changed);document.removeEventListener("visibilitychange",hidden);current.dispose();library.current=null;};
  },[]);
  return <section className="mx-auto max-w-4xl space-y-5 px-4 py-8">
    <h1 className="text-2xl font-semibold">My media</h1>
    <p className="text-ink-muted">View images, audio and video you own using your saved identity.</p>
    <p><a className="underline" href="/media/record">Record audio or video</a></p>
    <p><a className="underline" href="/media/edit">Create an image draft</a></p>
    <IdentityBar />
    {!tenant ? <p role="status">Private media is not available on this site yet.</p> : <>
      <PrivateMediaUpload tenant={tenant} />
      <div className="flex gap-4">
        <button type="button" disabled={state.busy} className="underline disabled:opacity-50" onClick={()=>void library.current?.load(0)}>Refresh my media</button>
        {state.loaded && state.page>0 && <button type="button" disabled={state.busy} className="underline disabled:opacity-50" onClick={()=>void library.current?.load(state.page-1)}>Previous page</button>}
        {state.nextPage!==null && <button type="button" disabled={state.busy} className="underline disabled:opacity-50" onClick={()=>void library.current?.load(state.nextPage!)}>Next page</button>}
        {state.preview && <button type="button" className="underline" onClick={()=>library.current?.reset()}>Close preview</button>}
      </div>
      {state.loaded && <p className="text-sm text-ink-muted">Page {state.page+1} of 16. New or removed files may change the pages.</p>}
      {state.loaded && !state.objects.length && <p>No media on this page.</p>}
      <ul className="space-y-2">{state.objects.map((object,index)=><li key={object}>
        <button type="button" disabled={state.busy} className="underline disabled:opacity-50" onClick={()=>void library.current?.open(object,tenant)}>Open file {state.page*4+index+1}</button>
        <button type="button" disabled={state.busy} className="ml-4 underline disabled:opacity-50" onClick={()=>void library.current?.recipients(object)}>Manage sharing</button>
      </li>)}</ul>
      {state.audience && <section className="space-y-2" aria-label="File sharing">
        <h2 className="font-semibold">Sharing</h2>
        {!state.audience.readers.length && <p>No recipient grants to cancel.</p>}
        <ul>{state.audience.readers.map(reader=><li key={reader} className="my-2 flex flex-wrap gap-3">
          <span className="break-all font-mono text-xs">{reader}</span>
          <button type="button" disabled={state.busy} className="underline disabled:opacity-50"
            onClick={()=>void library.current?.cancel(state.audience!.object,reader)}>Stop sharing</button>
        </li>)}</ul>
      </section>}
      {state.preview && <PrivateMediaPreview preview={state.preview} />}
      <p role="status" aria-live="polite">{state.busy ? "Loading private media…" : state.message}</p>
    </>}
  </section>;
}
