// UI state/session contracts: CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { MediaQuotaExceeded } from "./media-client";
import { createMediaUploadPanel, type UploadPanelState } from "./media-upload-panel";
import type { createPrivateMediaBrowser } from "./media-browser-session";
import { rememberUnlockedMeshPair,forgetUnlockedMeshPair } from "./identity/unlocked-mesh";
const pub="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const tenant="11111111-1111-4111-8111-111111111111";
function setup(extra:{fetcher?:typeof fetch;upload?:(...args:unknown[])=>Promise<unknown>}={}) {
  let state:UploadPanelState|undefined,held:Uint8Array|undefined;const calls:string[]=[];
  const browser:typeof createPrivateMediaBrowser=()=>({
    pendingUpload:async()=>({object:"object",name:"private.png"}),discardUpload:async(_tenant:string,object:string)=>{assert.equal(object,"object");calls.push("discard");},
    upload:async(...args:unknown[])=>{calls.push("upload");held=(args[1] as {bytes:Uint8Array}|undefined)?.bytes;
      if(extra.upload)return extra.upload(...args);(args[4] as ()=>void)();(args[3] as (message:string)=>void)("Uploading…");return {object:"object"};},
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>);
  const panel=createMediaUploadPanel(tenant,next=>{state=next;},{browser,clock:()=>0,
    fetcher:extra.fetcher??(async()=>Response.json({enabled:true,principal:pub,expiresAt:1000}))});
  return {panel,state:()=>state!,calls,held:()=>held};
}
test.afterEach(()=>forgetUnlockedMeshPair());
test("upload, inspect, explicit resume and discard preserve bounded private UI state",async()=>{
  const f=setup();try {
    await f.panel.upload(new File([new Uint8Array([1,2,3])],"x.png",{type:"image/png"}));
    assert.deepEqual(Array.from(f.held()!),[0,0,0]);assert.match(f.state().message,/one-hour/);assert.equal(f.state().allocationConfirmed,true);
    await f.panel.inspect();assert.equal(f.state().pending?.name,"private.png");
    await f.panel.resume();assert.equal(f.state().pending,null);
    await f.panel.inspect();await f.panel.discard();assert.equal(f.state().pending,null);
    assert.deepEqual(f.calls,["upload","upload","discard"]);
  } finally {f.panel.dispose();}
});
test("failed upload retains recovery, clears plaintext and never automatically retries",async()=>{
  const f=setup({upload:async()=>{throw Error("lost");}});try {
    await f.panel.upload(new File([new Uint8Array([1])],"x.png",{type:"image/png"}));
    assert.equal(f.held()![0],0);assert.match(f.state().message,/retained/);assert.equal(f.calls.length,1);
    await f.panel.upload(new File([],"empty.png",{type:"image/png"}));assert.equal(f.calls.length,1);
  } finally {f.panel.dispose();}
});
test("bad sessions refuse and identity changes suppress a late result",async()=>{
  for(const response of [new Response(null,{status:403}),new Response("not JSON"),Response.json(null),
    Response.json({enabled:true,principal:"bad",expiresAt:1000}),Response.json({enabled:true,principal:pub,expiresAt:300001})]) {
    const f=setup({fetcher:async()=>response});await f.panel.inspect();assert.equal(f.state().pending,null);f.panel.dispose();
  }
  let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
  const f=setup({fetcher:async()=>{await waiting;return Response.json({enabled:true,principal:pub,expiresAt:1000});}});
  const pending=f.panel.inspect();await f.panel.inspect();
  rememberUnlockedMeshPair("switch",{pub,priv:"key",epub:pub,epriv:"key"});release();await pending;
  assert.equal(f.state().pending,null);assert.equal(f.state().busy,false);f.panel.dispose();await f.panel.resume();
});

test("session expiry removes the decrypted pending filename",async(t)=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const f=setup();try {
    await f.panel.inspect();assert.equal(f.state().pending?.name,"private.png");
    t.mock.timers.tick(1001);assert.equal(f.state().pending,null);assert.equal(f.state().busy,false);
  } finally {f.panel.dispose();}
});

test("discard requires an inspected draft",async()=>{
  const f=setup();try {await f.panel.discard();assert.deepEqual(f.calls,[]);}finally{f.panel.dispose();}
});

test("reservation confirmation survives a later failure but is cleared with the session",async()=>{
  const f=setup({upload:async(...args)=>{(args[4] as ()=>void)();throw Error("upload interrupted");}});
  try {
    await f.panel.upload(new File([new Uint8Array([1])],"x.png",{type:"image/png"}));
    assert.equal(f.state().allocationConfirmed,true);assert.match(f.state().message,/retained/);
    f.panel.reset();assert.equal(f.state().allocationConfirmed,false);
  }finally{f.panel.dispose();}
  const refused=setup({upload:async()=>{throw Error("allocation refused");}});
  try {await refused.panel.resume();assert.equal(refused.state().allocationConfirmed,false);}finally{refused.panel.dispose();}
});

test("quota refusal preserves pending recovery, clears plaintext and reports no success", async () => {
  const f=setup({upload:async()=>{throw new MediaQuotaExceeded();}});
  try {
    await f.panel.inspect();
    await f.panel.resume();
    assert.equal(f.state().pending?.name,"private.png");
    assert.match(f.state().message,/Storage quota reached/);
    assert.match(f.state().message,/did not complete/);
    await f.panel.upload(new File([new Uint8Array([1])],"x.png",{type:"image/png"}));
    assert.equal(f.held()![0],0);
    assert.equal(f.state().busy,false);
    assert.deepEqual(f.calls,["upload","upload"]);
  } finally { f.panel.dispose(); }
});
