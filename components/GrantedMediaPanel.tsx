"use client";

import { useEffect, useRef, useState } from "react";
import { createMediaLibrary, type MediaLibraryState } from "@/lib/media-library";
import { btnSecondary } from "@/lib/brand-ui";
import { PrivateMediaPreview } from "./PrivateMediaPreview";

/** Granted navigation uses the same current authorization and cleanup as My media. */
export function GrantedMediaPanel({tenant}: {tenant:string}) {
  const [state,setState]=useState<MediaLibraryState|null>(null);
  const library=useRef<ReturnType<typeof createMediaLibrary>|null>(null);
  useEffect(()=>{
    setState(null);
    const current=createMediaLibrary(setState);library.current=current;
    const changed=()=>current.reset("Identity changed. Refresh granted media.");
    const hidden=()=>{if(document.visibilityState==="hidden")current.reset();};
    window.addEventListener("s3rch-session-changed",changed);
    document.addEventListener("visibilitychange",hidden);
    return ()=>{
      window.removeEventListener("s3rch-session-changed",changed);
      document.removeEventListener("visibilitychange",hidden);
      current.dispose();library.current=null;
    };
  },[tenant]);
  const page=state?.granted;
  return <section aria-label="Granted private media" className="mt-8 space-y-3">
    <h2 className="text-base font-semibold">Private media</h2>
    <p className="text-sm text-ink-muted">Open files shared with your current identity. Access is checked again when you open a file.</p>
    <button type="button" disabled={state?.busy} className={btnSecondary} onClick={()=>void library.current?.loadGranted(0)}>Refresh granted media</button>
    {page && <>
      <p className="text-xs text-ink-muted">Page {page.page+1} of 16.</p>
      {!page.objects.length && <p>No currently available shared files on this page.</p>}
      <ul className="space-y-3">{page.objects.map((object,index)=><li key={object}>
        <button type="button" disabled={state?.busy} className={btnSecondary} onClick={()=>void library.current?.open(object,tenant)}>Open shared file {page.page*4+index+1}</button>
      </li>)}</ul>
      {page.page>0 && <button type="button" disabled={state?.busy} className={btnSecondary} onClick={()=>void library.current?.loadGranted(page.page-1)}>Previous granted page</button>}
      {page.nextPage!==null && <button type="button" disabled={state?.busy} className={btnSecondary} onClick={()=>void library.current?.loadGranted(page.nextPage!)}>Next granted page</button>}
    </>}
    {state?.preview && <>
      <PrivateMediaPreview preview={state.preview}/>
      <button type="button" className={btnSecondary} onClick={()=>library.current?.reset()}>Close private preview</button>
    </>}
    <p role="status" aria-live="polite">{state?.busy ? "Loading private media…" : state?.message}</p>
  </section>;
}
