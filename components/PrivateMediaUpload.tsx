"use client";
import { privateMediaTags } from "@/lib/media-tags";
import { useEffect, useRef, useState } from "react";
import { subscribeUnlockedMeshPair } from "@/lib/identity/unlocked-mesh";
import { createMediaUploadPanel, type UploadPanelState } from "@/lib/media-upload-panel";

export function PrivateMediaUpload({tenant,preparedFile}:{tenant:string;preparedFile?:File}) {
  const [state,setState]=useState<UploadPanelState>({busy:false,message:"",allocationConfirmed:false,pending:null});
  const [file,setFile]=useState<File|null>(preparedFile??null),[discard,setDiscard]=useState(false);
  const [tags,setTags]=useState(""),[tagError,setTagError]=useState("");
  const input=useRef<HTMLInputElement|null>(null);
  const panel=useRef<ReturnType<typeof createMediaUploadPanel>|null>(null);
  useEffect(()=>{
    const current=createMediaUploadPanel(tenant,setState);panel.current=current;
    const changed=()=>{current.reset();setFile(null);setTags("");setTagError("");setDiscard(false);if(input.current)input.current.value="";};
    const hidden=()=>{if(document.visibilityState==="hidden")changed();};
    const unsubscribe=subscribeUnlockedMeshPair(changed);
    window.addEventListener("s3rch-session-changed",changed);document.addEventListener("visibilitychange",hidden);
    return ()=>{unsubscribe();window.removeEventListener("s3rch-session-changed",changed);document.removeEventListener("visibilitychange",hidden);current.dispose();panel.current=null;};
  },[tenant]);
  return <section aria-label="Private upload" className="space-y-3 rounded border p-4">
    <h2 className="font-semibold">Upload a private file</h2>
    <p className="text-sm text-ink-muted">Only you receive access. New files open after a one-hour settlement period. An encrypted recovery draft stays in this browser until upload completes.</p>
    {preparedFile ? <p>Prepared file: {preparedFile.name}</p> : <label className="block">Image, audio or video (up to 63 MiB)
      <input ref={input} type="file" disabled={state.busy} className="block max-w-full" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,audio/mpeg,audio/ogg,audio/wav,audio/webm,audio/mp4,video/mp4,video/webm,video/ogg"
        onChange={event=>{setFile(event.target.files?.[0]??null);setTags("");setTagError("");}} />
    </label>}
    {file?.type.startsWith("audio/")&&<label className="block">Audio tags (comma separated)
      <input aria-label="Audio tags" className="block w-full border p-2" value={tags} maxLength={512} disabled={state.busy}
        onChange={event=>{setTags(event.target.value);setTagError("");}} />
      <span className="text-sm text-ink-muted">Up to 12 tags. Only people with access can read them.</span>
    </label>}
    {tagError&&<p role="alert">{tagError}</p>}
    <div className="flex flex-wrap gap-4">
      <button type="button" className="underline disabled:opacity-50" disabled={state.busy||!file||!!state.pending}
        onClick={()=>{if(file){let selectedTags:readonly string[]=[];try{selectedTags=privateMediaTags(tags.split(",").map(tag=>tag.trim()).filter(Boolean));}catch{setTagError("Use up to 12 tags of 40 characters each.");return;}
          const selected=file;setFile(null);setTags("");setTagError("");setDiscard(false);if(input.current)input.current.value="";void panel.current?.upload(selected,selectedTags);}}}>Upload privately</button>
      <button type="button" className="underline disabled:opacity-50" disabled={state.busy} onClick={()=>{setDiscard(false);void panel.current?.inspect();}}>Check pending upload</button>
    </div>
    {state.pending&&<div className="space-y-2">
      <p className="break-all">Pending: {state.pending.name}</p>
      <button type="button" className="underline disabled:opacity-50" disabled={state.busy} onClick={()=>{setDiscard(false);void panel.current?.resume();}}>Resume this upload</button>
      <label className="block text-sm"><input type="checkbox" disabled={state.busy} checked={discard} onChange={event=>setDiscard(event.target.checked)} /> Discarding this browser’s recovery draft may make an unfinished upload unrecoverable. It does not delete uploaded data.</label>
      <button type="button" className="underline disabled:opacity-50" disabled={state.busy||!discard} onClick={()=>{setDiscard(false);void panel.current?.discard();}}>Discard local recovery draft</button>
    </div>}
    {state.allocationConfirmed&&<p className="text-sm">One private-media allocation is confirmed for this upload. Discarding its local draft does not release that reservation.</p>}
    <p role="status" aria-live="polite">{state.message}</p>
  </section>;
}
