"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/chat";
import { composeCurrentRoomMedia } from "@/lib/room-media-composition";
import { composeRoomMedia, parseRoomMedia } from "@/lib/room-media";
import { createMediaLibrary, type MediaLibraryState } from "@/lib/media-library";
import { mediaPreviewKind } from "@/lib/media-preview";
import { useRoomAuthority } from "./RoomAuthorityProvider";
import { useIdentitySession } from "./useIdentitySession";
import { useMediaTenant } from "./useMediaTenant";
import { PrivateMediaPreview } from "./PrivateMediaPreview";
import { btnSecondary } from "@/lib/brand-ui";

export function RoomMedia({roomId,messages,onPublicGraph,onComposed}: {
  roomId:string;messages:readonly ChatMessage[];onPublicGraph:boolean;
  onComposed:(message:ChatMessage,putOnGun:boolean)=>void;
}) {
  const session=useIdentitySession();
  const {current:authority}=useRoomAuthority();
  const [expanded,setExpanded]=useState(false);
  const current=useRef({authority,owner:session?.owner,roomId});
  current.current={authority,owner:session?.owner,roomId};
  return <section className="mt-4 space-y-3" aria-label="Room private media">
    <button type="button" className={btnSecondary} onClick={()=>setExpanded(value=>!value)}>{expanded?"Close room media":"Open room media"}</button>
    {expanded && <ConfiguredRoomMedia key={roomId+":"+(session?.owner??"")} roomId={roomId} messages={messages}
      canRead={message=>!!authority?.admission.valid(message)}
      send={async (body,stillCurrent)=>{
        if(!authority || !session)return false;
        const next=await composeCurrentRoomMedia({room:roomId,body,admission:authority.admission,pair:authority.pair,
          current:()=>stillCurrent() && current.current.authority===authority && current.current.owner===session.owner && current.current.roomId===roomId});
        if(!next)return false;
        onComposed(next,onPublicGraph);return true;
      }}/>}</section>;
}

type PanelProps={roomId:string;messages:readonly ChatMessage[];canRead:(message:ChatMessage)=>boolean;send:(body:string,stillCurrent:()=>boolean)=>Promise<boolean>};
function ConfiguredRoomMedia(props:PanelProps) {
  const tenant=useMediaTenant();
  if(tenant===undefined)return <p role="status">Loading private media availability…</p>;
  if(!tenant)return <p>Private media is not available on this site yet.</p>;
  return <RoomMediaPanel key={tenant} {...props} tenant={tenant}/>;
}

/** Only admitted room rows reach this view; each open independently checks file access. */
export function RoomMediaPanel({tenant,roomId,messages,canRead,send}:PanelProps&{tenant:string}) {
  const [state,setState]=useState<MediaLibraryState|null>(null);
  const [selected,setSelected]=useState<{object:string;message?:ChatMessage}|null>(null);
  const [sending,setSending]=useState(false),[notice,setNotice]=useState("");
  const library=useRef<ReturnType<typeof createMediaLibrary>|null>(null);
  const current=useRef({canRead,send});current.current={canRead,send};
  const generation=useRef(0),busy=useRef(false);
  useEffect(()=>{
    setState(null);setSelected(null);setNotice("");
    const controller=createMediaLibrary(setState);library.current=controller;
    const reset=()=>{generation.current++;setSelected(null);setNotice("");controller.reset();};
    const hidden=()=>{if(document.visibilityState==="hidden")reset();};
    window.addEventListener("s3rch-session-changed",reset);
    document.addEventListener("visibilitychange",hidden);
    return ()=>{generation.current++;window.removeEventListener("s3rch-session-changed",reset);
      document.removeEventListener("visibilitychange",hidden);controller.dispose();library.current=null;};
  },[tenant,roomId]);
  const references=messages.filter(message=>message.room===roomId && canRead(message) && parseRoomMedia(message.body)).slice(-64);
  async function open(object:string,message?:ChatMessage) {
    if(!library.current || state?.busy || busy.current || (message && !current.current.canRead(message)))return;
    generation.current++;setNotice("");setSelected({object,...(message?{message}:{})});
    if(message)await library.current.openReference(object,tenant);
    else await library.current.open(object,tenant);
  }
  async function submit() {
    const body=selected && !selected.message && composeRoomMedia(selected.object);
    if(!body || !state?.preview || !["audio","video"].includes(mediaPreviewKind(state.preview.mediaType)??"") || busy.current)return;
    const attempt=generation.current;busy.current=true;setSending(true);setNotice("");
    try {const sent=await current.current.send(body,()=>attempt===generation.current);if(attempt===generation.current)setNotice(sent?"Reference sent. File access is unchanged.":"Could not send. Check room access and unlock your identity.");}
    catch {if(attempt===generation.current)setNotice("Could not send. Check room access and unlock your identity.");}
    finally {busy.current=false;setSending(false);}
  }
  return <div className="space-y-3">
    <p className="text-sm text-ink-muted">Room references do not share files. Each listener needs their own current file access. A publicly shared room exposes the reference, but not the encrypted file or its key.</p>
    {!!references.length && <ul className="space-y-2">{references.map((message,index)=><li key={message.id}>
      <button type="button" className={btnSecondary} disabled={state?.busy||sending} onClick={()=>void open(parseRoomMedia(message.body)!,message)}>Open room file {index+1}</button>
    </li>)}</ul>}
    <button type="button" className={btnSecondary} disabled={state?.busy||sending} onClick={()=>{setSelected(null);void library.current?.load(0);}}>Choose my audio or video</button>
    {state?.loaded && <>
      <p>My files, page {state.page+1} of 16. Open a file to select it.</p>
      <ul>{state.objects.map((object,index)=><li key={object}><button type="button" className={btnSecondary} disabled={state.busy||sending} onClick={()=>void open(object)}>Select my file {state.page*4+index+1}</button></li>)}</ul>
      {state.page>0 && <button type="button" disabled={state.busy||sending} onClick={()=>{setSelected(null);void library.current?.load(state.page-1);}}>Previous files</button>}
      {state.nextPage!==null && <button type="button" disabled={state.busy||sending} onClick={()=>{setSelected(null);void library.current?.load(state.nextPage!);}}>Next files</button>}
    </>}
    {state?.preview && <>
      <PrivateMediaPreview preview={state.preview}/>
      <button type="button" className={btnSecondary} onClick={()=>{generation.current++;setSelected(null);library.current?.reset();}}>Close room preview</button>
      {selected && !selected.message && ["audio","video"].includes(mediaPreviewKind(state.preview.mediaType)??"") &&
        <button type="button" className={btnSecondary} disabled={sending||state.busy} onClick={()=>void submit()}>Send file reference</button>}
    </>}
    <p role="status">{state?.busy?"Loading private media…":notice||state?.message}</p>
  </div>;
}
