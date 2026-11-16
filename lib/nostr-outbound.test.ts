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
  close() { /* Deliberately unresponsive graceful-close peer. */ }
  terminate() { this.closed = true; this.dispatchEvent(new Event("close")); }
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

// Real loopback transport qualification is CI-only; no local/shared-host execution.
test("CI: an unresponsive close peer cannot retain a timed-out publisher socket", {skip:!process.env.CI, timeout:5000}, async () => {
 const {createServer} = await import("node:net");
 const {createHash} = await import("node:crypto");
 const peers = new Set<import("node:net").Socket>();
 const server = createServer(peer => {
  peers.add(peer); peer.on("error", () => {});
  peer.once("data", raw => {
   const key = /Sec-WebSocket-Key: ([^\r\n]+)/i.exec(raw.toString())?.[1];
   assert.ok(key);
   const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
   peer.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
   peer.pause(); // Never read EVENT or reply to a graceful CLOSE.
  });
 });
 const Client = createRequire(import.meta.url)("ws") as new (url:string) => Pick<WebSocket,"addEventListener"|"removeEventListener"|"send"|"close"|"readyState"> & {terminate:()=>void};
 try {
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const f = await fixture(); let client: InstanceType<typeof Client> | undefined, opened = false;
  const adapter = new NostrOutbound({...f,timeoutMs:250,connect:() => {
   client = new Client(`ws://127.0.0.1:${port}`);
   client.addEventListener("open", () => {opened = true;}); return client;
  }});
  assert.equal((await adapter.post({body:"hello"})).ok,false); assert.equal(opened,true);
  await new Promise<void>((resolve,reject) => {
   const timer = setTimeout(() => reject(Error("socket retained after timeout")),1000);
   const closed = () => {clearTimeout(timer); resolve();};
   if(client!.readyState === 3) closed(); else client!.addEventListener("close",closed,{once:true});
  });
  assert.equal(client!.readyState,3);
 } finally {
  for(const peer of peers) peer.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
 }
});
