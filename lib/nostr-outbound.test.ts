import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { NostrOutbound } from "./nostr-outbound";
import { verifiedNostrEvent, type NostrEvent } from "./nostr-event";
const sea = createRequire(import.meta.url)("gun/sea") as {pair():Promise<{pub:string}>};
class Relay extends EventTarget {
  closed = false;
  event?: NostrEvent;
  reply: (event:NostrEvent) => void = event => this.frame(["OK",event.id,true,""]);
  send(raw:string) { const [type,event] = JSON.parse(raw); assert.equal(type,"EVENT"); this.event = event; this.reply(event); }
  close() { this.closed = true; }
  frame(value:unknown) { this.dispatchEvent(new MessageEvent("message", {data:JSON.stringify(value)})); }
}
async function fixture() {
 const {pub:owner} = await sea.pair();
 const env = {NOSTR_OUTBOUND_OWNER:owner, NOSTR_SIGNER_KEY:"0".repeat(63)+"3", NOSTR_OUTBOUND_RELAY:"wss://relay.example"};
 return {owner, env};
}
test("owner-scoped Nostr signs the exact body and waits for matching acknowledgement",async()=>{
 const f = await fixture(), relay = new Relay();
 const adapter = new NostrOutbound({...f,connect:()=>relay});
 const pending = adapter.post({body:"hello",permalink:"https://private.example",tags:["private"]});
 relay.dispatchEvent(new Event("open"));
 const result = await pending; assert.equal(result.ok,true); assert.equal(relay.closed,true);
 const event = relay.event!;
 assert.ok(await verifiedNostrEvent(event,[event.pubkey],1,Math.floor(Date.now()/1000)));
 assert.equal(event.content,"hello"); assert.deepEqual(event.tags,[]);
});
test("missing, invalid, public, or other-owner credentials never connect",async()=>{
 const f = await fixture();
 for (const options of [{...f,owner:undefined},{...f,owner:(await sea.pair()).pub},{...f,env:{}},
   {...f,env:{...f.env,NOSTR_SIGNER_KEY:"0".repeat(64)}},
   {...f,env:{...f.env,NEXT_PUBLIC_NOSTR_SIGNER_KEY:f.env.NOSTR_SIGNER_KEY}},
   {...f,env:{...f.env,NOSTR_OUTBOUND_RELAY:"ws://relay.example"}}]) {
  const adapter = new NostrOutbound({...options,connect:()=>{assert.fail("must not connect");}});
  assert.equal(adapter.enabled,false); assert.equal((await adapter.post({body:"hello"})).ok,false);
 }
});
test("wrong IDs do not acknowledge; rejection, malformed frames, timeout and abort close the socket",async()=>{
 const f = await fixture();
 for (const mode of ["wrong", "reject", "malformed", "flood", "abort", "close"] as const) {
  const relay = new Relay(), abort = new AbortController();
  relay.reply = event => {
   if(mode === "wrong") relay.frame(["OK","0".repeat(64),true,""]);
   if(mode === "reject") relay.frame(["OK",event.id,false,"secret server error"]);
   if(mode === "malformed") relay.frame(["OK",event.id,true]);
   if(mode === "flood") for(let i=0;i<33;i++) relay.frame(["NOTICE",""]);
   if(mode === "abort") abort.abort();
   if(mode === "close") relay.dispatchEvent(new Event("close"));
  };
  const adapter = new NostrOutbound({...f,signal:abort.signal,connect:()=>relay,timeoutMs:10});
  const pending = adapter.post({body:"hello"}); relay.dispatchEvent(new Event("open"));
  const result = await pending; assert.equal(result.ok,false,mode); assert.equal(relay.closed,true,mode);
  assert.ok(!JSON.stringify(result).includes("secret"));
 }
});
test("oversized, malformed Unicode, empty and cancelled notes fail before connecting",async()=>{
 const f = await fixture(); const abort = new AbortController();
 const adapter = new NostrOutbound({...f,signal:abort.signal,connect:()=>{assert.fail("must not connect");}});
 for(const body of ["", "🦊".repeat(5000), "\ud800"]) assert.equal((await adapter.post({body})).ok,false);
 abort.abort(); assert.equal((await adapter.post({body:"hello"})).ok,false);
});
