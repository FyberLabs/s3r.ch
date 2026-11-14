"use client";
import {useEffect,useMemo,useRef,useState} from "react";
import {createRecordingDraft,type RecordingState,type RecordingMode} from "@/lib/media-recorder";
import {PrivateMediaUpload} from "./PrivateMediaUpload";
import {subscribeUnlockedMeshPair} from "@/lib/identity/unlocked-mesh";
export function MediaRecorderDraft({tenant=null}:{tenant?:string|null}){
 const [state,setState]=useState<RecordingState>({phase:"idle",mode:"audio",stream:null,url:null,blob:null,name:null,message:""}),[mode,setMode]=useState<RecordingMode>("audio");
 const recorder=useRef<ReturnType<typeof createRecordingDraft>|null>(null),preview=useRef<HTMLVideoElement|null>(null);
 useEffect(()=>{const current=createRecordingDraft(setState);recorder.current=current;const clear=()=>current.clear();const unsubscribe=subscribeUnlockedMeshPair(clear);const hidden=()=>{if(document.visibilityState==="hidden")clear();};
  const storage=(event:StorageEvent)=>{if(event.key===null||event.key==="s3rch-session-changed")clear();};
  window.addEventListener("pagehide",clear);window.addEventListener("storage",storage);window.addEventListener("s3rch-session-changed",clear);document.addEventListener("visibilitychange",hidden);
  return()=>{unsubscribe();window.removeEventListener("pagehide",clear);window.removeEventListener("storage",storage);window.removeEventListener("s3rch-session-changed",clear);document.removeEventListener("visibilitychange",hidden);current.dispose();recorder.current=null;};},[]);
 useEffect(()=>{const video=preview.current;if(!video)return;video.srcObject=state.stream;if(state.stream)void video.play().catch(()=>{});return()=>{video.pause();video.srcObject=null;};},[state.stream]);
 const file=useMemo(()=>state.phase==="ready"&&state.blob&&state.name?new File([state.blob],state.name,{type:state.blob.type}):null,[state.phase,state.blob,state.name]);
 const busy=["requesting","recording","stopping"].includes(state.phase);
 return <section className="mx-auto max-w-3xl space-y-4 px-4 py-8">
  <h1 className="text-2xl font-semibold">Recording draft</h1>
  <p>Record up to two minutes, then save the file or explicitly upload it privately. Switching away, changing identity, clearing or leaving stops capture and discards this tab’s draft. An encrypted recovery copy already saved by the uploader can still be resumed from My media.</p>
  <p className="text-sm text-ink-muted">Private upload uses the same storage and access controls as My media. Finishing a recording does not upload it.</p>
  <label>Recording type<select className="ml-3 border" value={mode} disabled={busy} onChange={event=>{recorder.current?.clear();setMode(event.target.value as RecordingMode);}}><option value="audio">Audio</option><option value="video">Video with audio</option></select></label>
  <div className="flex gap-4"><button type="button" className="underline" disabled={busy} onClick={()=>void recorder.current?.start(mode)}>Start {mode} recording</button>
   {state.phase==="recording"?<button type="button" className="underline" onClick={()=>recorder.current?.stop()}>Stop recording</button>:null}
   <button type="button" className="underline" onClick={()=>recorder.current?.clear()}>Clear recording</button></div>
  {state.phase==="recording"&&state.mode==="video"?<video ref={preview} muted playsInline aria-label="Live camera preview" className="max-w-full"/>:null}
  {state.url?(state.mode==="video"?<video src={state.url} controls preload="metadata" className="max-w-full" aria-label="Recorded video"/>:<audio src={state.url} controls preload="metadata" aria-label="Recorded audio"/>):null}
  {state.url&&state.name?<a className="underline" href={state.url} download={state.name}>Save recording</a>:null}
  {file&&tenant&&<PrivateMediaUpload key={state.url} tenant={tenant} preparedFile={file} />}
  {!tenant&&<p>Private upload is not configured on this site. You can still save the recording.</p>}
  <p><a className="underline" href="/media">My media and sharing</a></p>
  <p role="status" aria-live="polite">{state.phase==="requesting"?"Waiting for microphone or camera permission…":state.phase==="recording"?"Recording. Stops automatically after two minutes.":state.phase==="stopping"?"Finishing recording…":state.message}</p>
 </section>;
}
