/** Browser-local capture. No upload, session issuance or storage authorization. */
export type RecordingMode="audio"|"video";
export type RecordingState=Readonly<{phase:"idle"|"requesting"|"recording"|"stopping"|"ready"|"error";mode:RecordingMode;stream:MediaStream|null;url:string|null;name:string|null;message:string}>;
export const RECORDING_BYTES_MAX=16*1024*1024,RECORDING_MS_MAX=120_000;
export type RecordingDependencies={getUserMedia:(constraints:MediaStreamConstraints)=>Promise<MediaStream>;supported:(mime:string)=>boolean;recorder:(stream:MediaStream,mime:string)=>MediaRecorder;url:(blob:Blob)=>string;revoke:(url:string)=>void;later:(fn:()=>void,ms:number)=>ReturnType<typeof setTimeout>;cancel:(timer:ReturnType<typeof setTimeout>)=>void};
const defaults:RecordingDependencies={getUserMedia:constraints=>navigator.mediaDevices.getUserMedia(constraints),supported:mime=>MediaRecorder.isTypeSupported(mime),recorder:(stream,mime)=>new MediaRecorder(stream,{mimeType:mime}),url:blob=>URL.createObjectURL(blob),revoke:url=>URL.revokeObjectURL(url),later:setTimeout,cancel:clearTimeout};
export function createRecordingDraft(changed:(state:RecordingState)=>void,deps:RecordingDependencies=defaults){
 let state:RecordingState={phase:"idle",mode:"audio",stream:null,url:null,name:null,message:""};
 let generation=0,disposed=false,active:{recorder:MediaRecorder;stream:MediaStream;chunks:Blob[];size:number;timer:ReturnType<typeof setTimeout>|null}|null=null;
 const emit=(next:Partial<RecordingState>)=>{state={...state,...next};if(!disposed)changed(state);};
 function release(){const held=active;active=null;if(!held)return;if(held.timer!==null)deps.cancel(held.timer);held.recorder.ondataavailable=null;held.recorder.onstop=null;held.recorder.onerror=null;
  try{if(held.recorder.state!=="inactive")held.recorder.stop();}catch{/* Tracks are still stopped below. */}
  held.stream.getTracks().forEach(track=>track.stop());held.chunks.length=0;}
 function clear(){generation++;release();if(state.url)deps.revoke(state.url);emit({phase:"idle",stream:null,url:null,name:null,message:""});}
 function fail(message:string){clear();emit({phase:"error",message});}
 function stop(){if(!active||state.phase!=="recording")return;emit({phase:"stopping",stream:null});const held=active;
  try{held.recorder.stop();held.stream.getTracks().forEach(track=>track.stop());}catch{fail("Could not finish the recording. Try again.");}}
 async function start(mode:RecordingMode){
  if(disposed)return;clear();if(mode!=="audio"&&mode!=="video"){fail("Choose audio or video.");return;}
  const token=generation;emit({phase:"requesting",mode});let stream:MediaStream|null=null;
  try{
   const types=mode==="audio"?["audio/webm;codecs=opus","audio/mp4"]:["video/webm;codecs=vp8,opus","video/mp4"];
   const mime=types.find(deps.supported);if(!mime)throw Error();
   stream=await deps.getUserMedia({audio:true,video:mode==="video"?{width:{ideal:1280,max:1920},height:{ideal:720,max:1080},frameRate:{ideal:24,max:30}}:false});
   if(disposed||token!==generation){stream.getTracks().forEach(track=>track.stop());return;}
   const recorder=deps.recorder(stream,mime),held={recorder,stream,chunks:[] as Blob[],size:0,timer:null as ReturnType<typeof setTimeout>|null};active=held;
   recorder.ondataavailable=event=>{if(active!==held||token!==generation)return;
    if(event.data.size>RECORDING_BYTES_MAX-held.size){fail("Recording exceeded 16 MiB and was discarded. Try a shorter recording.");return;}
    if(event.data.size){held.size+=event.data.size;held.chunks.push(event.data);}};
   recorder.onerror=()=>{if(active===held)fail("Recording failed and was discarded. Try again.");};
   recorder.onstop=()=>{if(active!==held||token!==generation)return;
    try{if(!held.size)throw Error();const blob=new Blob(held.chunks,{type:mime.split(";")[0]});const url=deps.url(blob);release();emit({phase:"ready",stream:null,url,name:`s3rch-${mode}.${mime.includes("webm")?"webm":"mp4"}`,message:"Recording stays in this tab until you save it."});}
    catch{fail("Could not finish the recording. Try again.");}};
   recorder.start(1000);emit({phase:"recording",stream});held.timer=deps.later(stop,RECORDING_MS_MAX);
  }catch{stream?.getTracks().forEach(track=>track.stop());if(token===generation&&!disposed)fail("Microphone or camera is unavailable. Check permission and browser support.");}
 }
 return {start,stop,clear,dispose(){if(disposed)return;disposed=true;clear();},getState:()=>state};
}
