// UI state/session contracts: CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { createMediaUploadPanel, type UploadPanelState } from "./media-upload-panel";
import type { createPrivateMediaBrowser } from "./media-browser-session";
import { rememberUnlockedMeshPair,forgetUnlockedMeshPair } from "./identity/unlocked-mesh";
const pub="axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const tenant="11111111-1111-4111-8111-111111111111";
function setup(extra:{fetcher?:typeof fetch;upload?:(...args:unknown[])=>Promise<unknown>}={}) {
  let state:UploadPanelState|undefined,held:Uint8Array|undefined;const calls:string[]=[];
  const browser:typeof createPrivateMediaBrowser=()=>({
    pendingUpload:async()=>({object:"object",name:"private.png"}),discardUpload:async()=>{calls.push("discard");},
    upload:async(...args:unknown[])=>{calls.push("upload");held=(args[1] as {bytes:Uint8Array}|undefined)?.bytes;
      if(extra.upload)return extra.upload(...args);(args[3] as (message:string)=>void)("Uploading…");return {object:"object"};},
  } as unknown as ReturnType<typeof createPrivateMediaBrowser>);
  const panel=createMediaUploadPanel(tenant,next=>{state=next;},{browser,clock:()=>0,
    fetcher:extra.fetcher??(async()=>Response.json({enabled:true,principal:pub,expiresAt:1000}))});
  return {panel,state:()=>state!,calls,held:()=>held};
}
test.afterEach(()=>forgetUnlockedMeshPair());
test("upload, inspect, explicit resume and discard preserve bounded private UI state",async()=>{
  const f=setup();try {
    await f.panel.upload(new File([new Uint8Array([1,2,3])],"x.png",{type:"image/png"}));
    assert.deepEqual(Array.from(f.held()!),[0,0,0]);assert.match(f.state().message,/one-hour/);
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
