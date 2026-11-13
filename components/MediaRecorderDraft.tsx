"use client";
import {useEffect,useRef,useState} from "react";
import {createRecordingDraft,type RecordingState,type RecordingMode} from "@/lib/media-recorder";
export function MediaRecorderDraft(){
 const [state,setState]=useState<RecordingState>({phase:"idle",mode:"audio",stream:null,url:null,name:null,message:""}),[mode,setMode]=useState<RecordingMode>("audio");
 const recorder=useRef<ReturnType<typeof createRecordingDraft>|null>(null),preview=useRef<HTMLVideoElement|null>(null);
 useEffect(()=>{const current=createRecordingDraft(setState);recorder.current=current;const clear=()=>current.clear();const hidden=()=>{if(document.visibilityState==="hidden")clear();};
  const storage=(event:StorageEvent)=>{if(event.key===null||event.key==="s3rch-session-changed")clear();};
  window.addEventListener("pagehide",clear);window.addEventListener("storage",storage);window.addEventListener("s3rch-session-changed",clear);document.addEventListener("visibilitychange",hidden);
  return()=>{window.removeEventListener("pagehide",clear);window.removeEventListener("storage",storage);window.removeEventListener("s3rch-session-changed",clear);document.removeEventListener("visibilitychange",hidden);current.dispose();recorder.current=null;};},[]);
 useEffect(()=>{const video=preview.current;if(!video)return;video.srcObject=state.stream;if(state.stream)void video.play().catch(()=>{});return()=>{video.pause();video.srcObject=null;};},[state.stream]);
 const busy=["requesting","recording","stopping"].includes(state.phase);
 return <section className="mx-auto max-w-3xl space-y-4 px-4 py-8">
  <h1 className="text-2xl font-semibold">Recording draft</h1>
  <p>Record up to two minutes and save the file. Recordings stay in this tab. Switching away, changing identity, clearing or leaving discards the draft and stops capture.</p>
  <p className="text-sm text-ink-muted">Coming in v1: publish audio and video posts with tags and sharing controls.</p>
  <label>Recording type<select className="ml-3 border" value={mode} disabled={busy} onChange={event=>{recorder.current?.clear();setMode(event.target.value as RecordingMode);}}><option value="audio">Audio</option><option value="video">Video with audio</option></select></label>
  <div className="flex gap-4"><button type="button" className="underline" disabled={busy} onClick={()=>void recorder.current?.start(mode)}>Start {mode} recording</button>
   {state.phase==="recording"?<button type="button" className="underline" onClick={()=>recorder.current?.stop()}>Stop recording</button>:null}
   <button type="button" className="underline" onClick={()=>recorder.current?.clear()}>Clear recording</button></div>
  {state.phase==="recording"&&state.mode==="video"?<video ref={preview} muted playsInline aria-label="Live camera preview" className="max-w-full"/>:null}
  {state.url?(state.mode==="video"?<video src={state.url} controls preload="metadata" className="max-w-full" aria-label="Recorded video"/>:<audio src={state.url} controls preload="metadata" aria-label="Recorded audio"/>):null}
  {state.url&&state.name?<a className="underline" href={state.url} download={state.name}>Save recording</a>:null}
  <p role="status" aria-live="polite">{state.phase==="requesting"?"Waiting for microphone or camera permission…":state.phase==="recording"?"Recording. Stops automatically after two minutes.":state.phase==="stopping"?"Finishing recording…":state.message}</p>
 </section>;
}
