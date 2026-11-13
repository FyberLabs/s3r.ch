import test from "node:test";
import assert from "node:assert/strict";
import {createRecordingDraft,RECORDING_BYTES_MAX,RECORDING_MS_MAX,type RecordingDependencies} from "./media-recorder";
function setup(){let stops=0,revoked=0,blob:Blob|null=null,timer:(()=>void)|null=null;const stream={getTracks:()=>[{stop(){stops++;}}]} as unknown as MediaStream;
 const fake={state:"inactive",ondataavailable:null as ((event:{data:Blob})=>void)|null,onstop:null as (()=>void)|null,onerror:null as (()=>void)|null,start(){this.state="recording";},stop(){this.state="inactive";}};
 const deps:RecordingDependencies={getUserMedia:async()=>stream,supported:()=>true,recorder:()=>fake as unknown as MediaRecorder,url:value=>{blob=value;return "blob:fixture";},revoke:()=>{revoked++;},later:fn=>{timer=fn;return 1 as unknown as ReturnType<typeof setTimeout>;},cancel:()=>{timer=null;}};
 const states:string[]=[];const draft=createRecordingDraft(s=>states.push(s.phase),deps);
 return {draft,deps,fake,stream,states,get stops(){return stops;},get revoked(){return revoked;},get blob(){return blob;},timeout(){timer?.();},data(size=3){fake.ondataavailable?.({data:new Blob([new Uint8Array(size)])});},finish(){fake.state="inactive";fake.onstop?.();}};
}
test("capture is explicit, bounded and exported without upload",async()=>{
 for(const mode of ["audio","video"] as const){const h=setup();let constraints:MediaStreamConstraints|undefined;h.deps.getUserMedia=async c=>{constraints=c;return h.stream;};await h.draft.start(mode);
 assert.equal(h.draft.getState().phase,"recording");assert.equal(constraints?.audio,true);assert.equal(!!constraints?.video,mode==="video");
 h.data(0);h.data();h.draft.stop();assert.equal(h.draft.getState().phase,"stopping");assert.ok(h.stops>0);h.finish();assert.equal(h.draft.getState().phase,"ready");assert.equal(h.blob?.size,3);assert.equal(h.blob?.type,`${mode}/webm`);assert.equal(h.draft.getState().name,`s3rch-${mode}.webm`);
 h.draft.clear();assert.equal(h.revoked,1);assert.equal(h.draft.getState().url,null);h.draft.stop();}
 assert.equal(RECORDING_MS_MAX,120000);
});
test("duration stops capture; oversize, empty and recorder errors discard it",async()=>{
 const timed=setup();await timed.draft.start("audio");timed.data();timed.timeout();assert.equal(timed.draft.getState().phase,"stopping");timed.finish();assert.equal(timed.draft.getState().phase,"ready");
 const large=setup();await large.draft.start("video");large.data(RECORDING_BYTES_MAX);large.data(1);assert.equal(large.draft.getState().phase,"error");assert.equal(large.blob,null);assert.ok(large.stops>0);
 const empty=setup();await empty.draft.start("audio");empty.finish();assert.equal(empty.draft.getState().phase,"error");
 const broken=setup();await broken.draft.start("audio");broken.fake.onerror?.();assert.equal(broken.draft.getState().phase,"error");
});
test("late permission and late recorder callbacks cannot restore a cleared draft",async()=>{
 for(const dispose of [false,true]){const h=setup();let resolve!:(s:MediaStream)=>void;h.deps.getUserMedia=()=>new Promise(r=>resolve=r);const starting=h.draft.start("video");if(dispose)h.draft.dispose();else h.draft.clear();resolve(h.stream);await starting;assert.ok(h.stops>0);assert.equal(h.draft.getState().phase,"idle");}
 const stale=setup();let timeout!:()=>void;stale.deps.later=fn=>{timeout=fn;return 1 as unknown as ReturnType<typeof setTimeout>;};await stale.draft.start("audio");const oldTimeout=timeout;await stale.draft.start("video");oldTimeout();assert.equal(stale.draft.getState().phase,"recording");stale.draft.dispose();
 const h=setup();await h.draft.start("audio");const data=h.fake.ondataavailable,done=h.fake.onstop,error=h.fake.onerror;h.draft.clear();data?.({data:new Blob(["late"])});done?.();error?.();assert.equal(h.draft.getState().phase,"idle");assert.equal(h.blob,null);
 h.draft.dispose();h.draft.dispose();await h.draft.start("audio");assert.equal(h.draft.getState().phase,"idle");
});
test("unsupported devices, invalid mode and encoder failures fail closed",async()=>{
 const unsupported=setup();unsupported.deps.supported=()=>false;await unsupported.draft.start("audio");assert.equal(unsupported.draft.getState().phase,"error");
 const denied=setup();denied.deps.getUserMedia=async()=>{throw Error("private device detail");};await denied.draft.start("audio");assert.doesNotMatch(denied.draft.getState().message,/private device/);
 const invalid=setup();await invalid.draft.start("bad" as never);assert.equal(invalid.draft.getState().phase,"error");
 const mp4=setup();mp4.deps.supported=m=>m.endsWith("mp4");await mp4.draft.start("audio");mp4.data();mp4.finish();assert.equal(mp4.draft.getState().name,"s3rch-audio.mp4");
 const failed=setup();failed.deps.recorder=()=>{throw Error();};await failed.draft.start("video");assert.ok(failed.stops>0);assert.equal(failed.draft.getState().phase,"error");
 const stop=setup();await stop.draft.start("audio");stop.fake.stop=()=>{throw Error();};stop.draft.stop();assert.ok(stop.stops>0);assert.equal(stop.draft.getState().phase,"error");
 const url=setup();url.deps.url=()=>{throw Error();};await url.draft.start("audio");url.data();url.finish();assert.equal(url.draft.getState().phase,"error");
});
