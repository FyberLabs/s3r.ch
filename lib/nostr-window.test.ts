import assert from "node:assert/strict";
import test from "node:test";
import { queryNostrRelay } from "./nostr";

for (const mode of ["eose", "close", "error", "timeout"] as const) {
  test(`Nostr window requires EOSE after events: ${mode}`, async t => {
    const original = globalThis.WebSocket;
    const event = { id: "a".repeat(64), kind: 1, pubkey: "b".repeat(64) };
    class FakeSocket extends EventTarget {
      static OPEN = 1;
      readyState = 1;
      constructor(_url: string) { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      send(data: string) {
        const [type, id] = JSON.parse(data);
        if (type !== "REQ") return;
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(["EVENT", id, event]) }));
        if (mode === "eose") this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(["EOSE", id]) }));
        else if (mode !== "timeout") this.dispatchEvent(new Event(mode));
      }
      close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
    }
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    t.after(() => { globalThis.WebSocket = original; });
    if (mode === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
    const result = queryNostrRelay("wss://example.org", { authors: ["b".repeat(64)], kinds: [1], limit: 20 });
    if (mode === "eose") assert.deepEqual(await result, [event]);
    else {
      const rejected = assert.rejects(result, /closed before EOSE|WebSocket error|timed out/);
      if (mode === "timeout") { await Promise.resolve(); t.mock.timers.tick(15000); }
      await rejected;
    }
  });
}

import {NOSTR_FRAME_BYTES_MAX,NOSTR_WINDOW_BYTES_MAX} from "./nostr";
const baseWebSocket=globalThis.WebSocket;
async function windowFixture(t:import("node:test").TestContext,frames:(id:string)=>unknown[],limit=2){
 const original=baseWebSocket;let closed=0;
 class Socket extends EventTarget{static OPEN=1;readyState=1;constructor(_url:string){super();queueMicrotask(()=>this.dispatchEvent(new Event("open")));}
  send(value:string){const [type,id]=JSON.parse(value);if(type!=="REQ")return;for(const data of frames(id))this.dispatchEvent(new MessageEvent("message",{data}));}
  close(){closed++;this.readyState=3;this.dispatchEvent(new Event("close"));}}
 globalThis.WebSocket=Socket as unknown as typeof WebSocket;t.after(()=>{globalThis.WebSocket=original;});
 const result=queryNostrRelay("wss://example.org",{authors:["b".repeat(64)],kinds:[1],limit});return {result,closed:()=>closed};
}
const eventFrame=(id:string,changes:Record<string,unknown>={})=>JSON.stringify(["EVENT",id,{id:"a".repeat(64),pubkey:"b".repeat(64),kind:1,...changes}]);
test("relay refuses oversized, binary, cumulative and excessive-frame windows",async t=>{
 for(const frames of [()=>["x".repeat(NOSTR_FRAME_BYTES_MAX+1)],()=>["é".repeat(NOSTR_FRAME_BYTES_MAX)],()=>[new Uint8Array([1])],()=>Array(129).fill("{}"),()=>Array(Math.ceil(NOSTR_WINDOW_BYTES_MAX/(NOSTR_FRAME_BYTES_MAX-1))+1).fill("x".repeat(NOSTR_FRAME_BYTES_MAX-1))]){
  const h=await windowFixture(t,frames);await assert.rejects(h.result,/exceeds its bounds/);assert.equal(h.closed(),1);
 }
});
test("requested event limit fails the whole window and late EOSE cannot admit a prefix",async t=>{
 const h=await windowFixture(t,id=>[eventFrame(id),eventFrame(id),eventFrame(id),JSON.stringify(["EOSE",id])]);await assert.rejects(h.result,/exceeds its bounds/);assert.equal(h.closed(),1);
});
test("only requested authors and kinds enter a successful window",async t=>{
 const h=await windowFixture(t,id=>[eventFrame(id,{pubkey:"c".repeat(64)}),eventFrame(id,{kind:30311}),JSON.stringify(["EVENT",id,null]),eventFrame("other"),eventFrame(id),JSON.stringify(["EOSE",id])]);
 assert.equal((await h.result).length,1);assert.equal(h.closed(),1);
});
test("invalid filters never open a socket",async()=>{
 for(const change of [{limit:0},{limit:101},{limit:NaN},{authors:[]},{authors:["bad"]},{kinds:[]},{kinds:[-1]},{kinds:[65536]}])await assert.rejects(queryNostrRelay("wss://example.org",{authors:["b".repeat(64)],kinds:[1],limit:20,...change}),/Invalid Nostr/);
});

import {fetchPublicNostr,PUBLIC_NOSTR_PUBKEYS} from "./nostr";
test("public pulls normalize complete windows and exclude failed relay windows",async t=>{
 const original=globalThis.WebSocket;let failSecond=false;
 class Socket extends EventTarget {
  static OPEN=1;readyState=1;
  constructor(_url:string){super();queueMicrotask(()=>this.dispatchEvent(new Event("open")));}
  send(value:string){
   const [type,id,filter]=JSON.parse(value);if(type!=="REQ")return;
   const pubkey=filter.authors[0];
   if(failSecond&&pubkey===PUBLIC_NOSTR_PUBKEYS[1])throw Error("fixture send failure");
   for(const event of [{id:pubkey,pubkey,kind:1,content:"Public note",created_at:123},{id:"invalid",pubkey,kind:1}])
    this.dispatchEvent(new MessageEvent("message",{data:JSON.stringify(["EVENT",id,event])}));
   this.dispatchEvent(new MessageEvent("message",{data:JSON.stringify(["EOSE",id])}));
  }
  close(){this.readyState=3;this.dispatchEvent(new Event("close"));}
 }
 globalThis.WebSocket=Socket as unknown as typeof WebSocket;t.after(()=>{globalThis.WebSocket=original;});
 const complete=await fetchPublicNostr();
 assert.equal(complete.sourcesOk,2);assert.equal(complete.items.length,2);assert.deepEqual(complete.completeSources,["nostr"]);
 assert.ok(complete.items.every(item=>item.body==="Public note"&&item.ts===123&&item.source==="nostr"));
 failSecond=true;const partial=await fetchPublicNostr();
 assert.equal(partial.sourcesOk,1);assert.equal(partial.windows?.length,1);assert.deepEqual(partial.completeSources,[]);
 assert.equal(partial.items[0].author,PUBLIC_NOSTR_PUBKEYS[0]);
});
