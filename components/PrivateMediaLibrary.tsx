"use client";

import { useEffect, useRef, useState } from "react";
import { createMediaLibrary, type MediaLibraryState } from "@/lib/media-library";
import { IdentityBar } from "./IdentityBar";
import { PrivateMediaUpload } from "./PrivateMediaUpload";
import { PrivateMediaPreview } from "./PrivateMediaPreview";

export function PrivateMediaLibrary({tenant}: {tenant: string|null}) {
  const [state,setState]=useState<MediaLibraryState>({busy:false,objects:[],page:0,nextPage:null,loaded:false,message:"",preview:null,audience:null,deletion:null,cleanup:null,granted:null,sharing:null,consent:null,groupCommand:null});
  const [abandon,setAbandon]=useState(false);
  useEffect(()=>{setAbandon(false);},[state.sharing?.token]);
  const [recipient,setRecipient]=useState("");
  useEffect(()=>{setRecipient("");},[state.audience?.object,state.loaded]);
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
        <button type="button" disabled={state.busy || !!state.deletion} className="underline disabled:opacity-50" onClick={()=>void library.current?.load(0)}>Refresh my media</button>
        {state.loaded && state.page>0 && <button type="button" disabled={state.busy || !!state.deletion} className="underline disabled:opacity-50" onClick={()=>void library.current?.load(state.page-1)}>Previous page</button>}
        {state.nextPage!==null && <button type="button" disabled={state.busy || !!state.deletion} className="underline disabled:opacity-50" onClick={()=>void library.current?.load(state.nextPage!)}>Next page</button>}
        {state.preview && <button type="button" className="underline" onClick={()=>library.current?.reset()}>Close preview</button>}
      </div>
      {state.loaded && <p className="text-sm text-ink-muted">Page {state.page+1} of 16. New or removed files may change the pages.</p>}
      {state.loaded && !state.objects.length && <p>No media on this page.</p>}
      <ul className="space-y-2">{state.objects.map((object,index)=><li key={object}>
        <button type="button" disabled={state.busy || !!state.deletion} className="underline disabled:opacity-50" onClick={()=>void library.current?.open(object,tenant)}>Open file {state.page*4+index+1}</button>
        <button type="button" disabled={state.busy || !!state.deletion} className="ml-4 underline disabled:opacity-50" onClick={()=>void library.current?.recipients(object)}>Manage sharing</button>
        <button type="button" disabled={state.busy || !!state.deletion} className="ml-4 underline disabled:opacity-50" onClick={()=>library.current?.requestDeletion(object)}>Delete file</button>
      </li>)}</ul>
      <section aria-labelledby="media-granted-title" className="space-y-3 rounded border p-4">
        <h2 id="media-granted-title" className="font-semibold">Granted media</h2>
        <p>Files shared with you appear while their access is current.</p>
        <button type="button" disabled={state.busy || !!state.deletion} className="underline disabled:opacity-50" onClick={()=>void library.current?.loadGranted(0)}>Refresh granted media</button>
        {state.granted && <>
          <p>Page {state.granted.page+1} of 16. Empty pages are valid.</p>
          {!state.granted.objects.length && <p>No currently available shared files on this page.</p>}
          <ul>{state.granted.objects.map((object,index)=><li key={object}>
            <button type="button" disabled={state.busy || !!state.deletion} className="underline disabled:opacity-50" onClick={()=>void library.current?.open(object,tenant)}>Open shared file {state.granted!.page*4+index+1}</button>
          </li>)}</ul>
          {state.granted.page>0 && <button type="button" disabled={state.busy || !!state.deletion} className="underline disabled:opacity-50" onClick={()=>void library.current?.loadGranted(state.granted!.page-1)}>Previous granted page</button>}
          {state.granted.nextPage!==null && <button type="button" disabled={state.busy || !!state.deletion} className="ml-4 underline disabled:opacity-50" onClick={()=>void library.current?.loadGranted(state.granted!.nextPage!)}>Next granted page</button>}
        </>}
      </section>
      <section aria-labelledby="media-cleanup-title" className="space-y-3 rounded border p-4">
        <h2 id="media-cleanup-title" className="font-semibold">Pending storage cleanup</h2>
        <p>Deleted files stay inaccessible while storage cleanup finishes. Retry a previously accepted deletion here.</p>
        <button type="button" disabled={state.busy || !!state.deletion} className="underline disabled:opacity-50" onClick={()=>void library.current?.loadCleanup(0)}>Refresh pending cleanup</button>
        {state.cleanup && <>
          <p>Page {state.cleanup.page+1} of 16. Empty pages are valid.</p>
          {!state.cleanup.objects.length && <p>No pending cleanup on this page.</p>}
          <ul>{state.cleanup.objects.map((item,index)=><li key={item.object}>
            <button type="button" disabled={state.busy || !!state.deletion} className="underline disabled:opacity-50" onClick={()=>void library.current?.cleanup(item.object,item.command)}>Retry cleanup for deleted file {state.cleanup!.page*4+index+1}</button>
          </li>)}</ul>
          {state.cleanup.page>0 && <button type="button" disabled={state.busy || !!state.deletion} className="underline disabled:opacity-50" onClick={()=>void library.current?.loadCleanup(state.cleanup!.page-1)}>Previous cleanup page</button>}
          {state.cleanup.nextPage!==null && <button type="button" disabled={state.busy || !!state.deletion} className="ml-4 underline disabled:opacity-50" onClick={()=>void library.current?.loadCleanup(state.cleanup!.nextPage!)}>Next cleanup page</button>}
        </>}
      </section>
      {state.deletion && <section aria-labelledby="delete-media-title" className="space-y-3 rounded border p-4">
        <h2 id="delete-media-title" className="font-semibold">Delete this file?</h2>
        <p>This permanently stops access through your library and shared links. Copies already saved cannot be removed. Storage cleanup happens separately.</p>
        <button type="button" disabled={state.busy} className="underline disabled:opacity-50" onClick={()=>void library.current?.confirmDeletion(tenant)}>{state.deletion.prepared ? "Retry deletion" : "Permanently delete file"}</button>
        <button type="button" disabled={state.busy} className="ml-4 underline disabled:opacity-50" onClick={()=>library.current?.cancelDeletion()}>{state.deletion.prepared ? "Close" : "Keep file"}</button>
      </section>}
      <section aria-label="Saved group change" className="space-y-2 rounded border p-4">
        <h2 className="font-semibold">Group change recovery</h2>
        <p>Refresh your media to check group changes saved by this identity.</p>
        <button type="button" disabled={state.busy||!!state.deletion||!state.loaded} className="underline disabled:opacity-50" onClick={()=>void library.current?.inspectGroupCommand(tenant)}>Check saved group change</button>
        {state.groupCommand && <>
          <p className="break-all">Saved {state.groupCommand.kind==="create"?"group creation":"membership change"}: {state.groupCommand.set}</p>
          <p>Retry confirms the saved request. Clearing its local copy does not undo an accepted change.</p>
          <button type="button" disabled={state.busy||!!state.deletion} className="underline disabled:opacity-50" onClick={()=>void library.current?.resumeGroupCommand(tenant)}>Retry saved group change</button>
          <button type="button" disabled={state.busy||!!state.deletion} className="ml-4 underline disabled:opacity-50" onClick={()=>void library.current?.discardGroupCommand(tenant)}>Clear reconciled group request</button>
        </>}
      </section>
      <section aria-label="Saved group response" className="space-y-2 rounded border p-4">
        <button type="button" disabled={state.busy||!!state.deletion} className="underline disabled:opacity-50" onClick={()=>void library.current?.inspectConsent(tenant)}>Check saved group response</button>
        {state.consent && <>
          <p>Saved request to {state.consent.stated===1?"join":"leave"} a group.</p>
          <p>Retry checks the original request. Clearing its local copy does not undo an accepted change.</p>
          <button type="button" disabled={state.busy||!!state.deletion} className="underline disabled:opacity-50" onClick={()=>void library.current?.resumeConsent(tenant)}>Retry saved group response</button>
          <button type="button" disabled={state.busy||!!state.deletion} className="ml-4 underline disabled:opacity-50" onClick={()=>void library.current?.discardConsent(tenant)}>Clear completed or expired request</button>
        </>}
      </section>
      <section aria-label="Saved sharing" className="space-y-2 rounded border p-4">
        <button type="button" disabled={state.busy||!!state.deletion} className="underline disabled:opacity-50" onClick={()=>void library.current?.inspectSharing(tenant)}>Check saved sharing</button>
        {state.sharing && <>
          <p className="break-all">Pending {state.sharing.remove?"removal of":"sharing with"} {state.sharing.reader}</p>
          <p>Resume uses the saved request. Sharing may wait for the access update to settle; closing this page does not undo accepted changes.</p>
          <button type="button" disabled={state.busy||!!state.deletion} className="underline disabled:opacity-50" onClick={()=>void library.current?.resumeSharing(tenant)}>Resume sharing</button>
          <label className="block"><input type="checkbox" checked={abandon} onChange={event=>setAbandon(event.target.checked)} disabled={state.busy}/> I understand that forgetting recovery does not undo accepted access changes.</label>
          <button type="button" disabled={state.busy||!!state.deletion||!abandon} className="underline disabled:opacity-50" onClick={()=>void library.current?.abandonSharing(tenant)}>Forget saved sharing</button>
        </>}
      </section>
      {state.audience && <section className="space-y-2" aria-label="File sharing">
        <h2 className="font-semibold">Sharing</h2>
        <label className="block">Recipient SEA account
          <input value={recipient} onChange={event=>setRecipient(event.target.value)} autoComplete="off" spellCheck={false} className="block w-full rounded border p-2" disabled={state.busy||!!state.sharing} />
        </label>
        <p>The recipient must already be enrolled. Sharing does not create an account.</p>
        <button type="button" disabled={state.busy||!!state.sharing||!recipient.trim()} className="underline disabled:opacity-50" onClick={()=>void library.current?.share(tenant,state.audience!.object,recipient.trim())}>Share with this identity</button>
        {!state.audience.readers.length && <p>No recipient grants to cancel.</p>}
        <ul>{state.audience.readers.map(reader=><li key={reader} className="my-2 flex flex-wrap gap-3">
          <span className="break-all font-mono text-xs">{reader}</span>
          <button type="button" disabled={state.busy || !!state.deletion} className="underline disabled:opacity-50"
            onClick={()=>void library.current?.unshare(tenant,state.audience!.object,reader)}>Stop sharing</button>
        </li>)}</ul>
      </section>}
      {state.preview && <PrivateMediaPreview preview={state.preview} />}
      <p role="status" aria-live="polite">{state.busy ? "Loading private media…" : state.message}</p>
    </>}
  </section>;
}
