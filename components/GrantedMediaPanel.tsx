"use client";

import { useEffect, useRef, useState } from "react";
import { createMediaLibrary, type MediaLibraryState } from "@/lib/media-library";
import { btnSecondary } from "@/lib/brand-ui";
import { IpfsPlaybackEndpoint } from "./IpfsPlaybackEndpoint";
import { PrivateMediaPreview } from "./PrivateMediaPreview";

/** Granted navigation uses the same current authorization and cleanup as My media. */
export function GrantedMediaPanel({tenant}: {tenant:string}) {
  const [ipfsEndpoint,setIpfsEndpoint]=useState("");
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
  const page=state?.granted,groups=state?.groupGranted;
  return <section aria-label="Granted private media" className="mt-8 space-y-3">
    <h2 className="text-base font-semibold">Private media</h2>
    <p className="text-sm text-ink-muted">Open files shared with your current identity. Access is checked again when you open a file.</p>
    <IpfsPlaybackEndpoint value={ipfsEndpoint} onChange={setIpfsEndpoint} disabled={state?.busy}/>
    <button type="button" disabled={state?.busy} className={btnSecondary} onClick={()=>void library.current?.loadGranted(0)}>Refresh granted media</button>
    {page && <>
      <p className="text-xs text-ink-muted">Page {page.page+1} of 16.</p>
      {!page.objects.length && <p>No currently available shared files on this page.</p>}
      <ul className="space-y-3">{page.objects.map((object,index)=><li key={object}>
        <button type="button" disabled={state?.busy} className={btnSecondary} onClick={()=>void library.current?.open(object,tenant,ipfsEndpoint.trim()||undefined)}>Open shared file {page.page*4+index+1}</button>
      </li>)}</ul>
      {page.page>0 && <button type="button" disabled={state?.busy} className={btnSecondary} onClick={()=>void library.current?.loadGranted(page.page-1)}>Previous granted page</button>}
      {page.nextPage!==null && <button type="button" disabled={state?.busy} className={btnSecondary} onClick={()=>void library.current?.loadGranted(page.nextPage!)}>Next granted page</button>}
    </>}
    <section aria-label="Granted through groups" className="space-y-3">
      <h3 className="text-sm font-semibold">Shared through groups</h3>
      <button type="button" disabled={state?.busy} className={btnSecondary} onClick={()=>void library.current?.loadGroupGranted(0)}>Refresh group media</button>
      {groups && <>
        <p className="text-xs text-ink-muted">Page {groups.page+1} of 16.</p>
        {!groups.entries.length && <p>No currently available group files on this page.</p>}
        <ul>{groups.entries.map((entry,index)=><li key={entry.object}>
          <button type="button" disabled={state?.busy} className={btnSecondary} onClick={()=>void library.current?.openGroup(entry,tenant)}>Open group file {groups.page*4+index+1}</button>
        </li>)}</ul>
        {groups.page>0 && <button type="button" disabled={state?.busy} className={btnSecondary} onClick={()=>void library.current?.loadGroupGranted(groups.page-1)}>Previous group page</button>}
        {groups.nextPage!==null && <button type="button" disabled={state?.busy} className={btnSecondary} onClick={()=>void library.current?.loadGroupGranted(groups.nextPage!)}>Next group page</button>}
      </>}
    </section>
    {state?.preview && <>
      <PrivateMediaPreview preview={state.preview}/>
      <button type="button" className={btnSecondary} onClick={()=>library.current?.reset()}>Close private preview</button>
    </>}
    <p role="status" aria-live="polite">{state?.busy ? "Loading private media…" : state?.message}</p>
  </section>;
}
