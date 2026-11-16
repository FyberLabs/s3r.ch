import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {MastodonOutbound} from "./mastodon-outbound";
const sea = createRequire(import.meta.url)("gun/sea") as {pair():Promise<{pub:string}>};
async function fixture() {
 const {pub:owner} = await sea.pair();
 return {owner,env:{MASTODON_OUTBOUND_OWNER:owner,MASTODON_OUTBOUND_ACCOUNT_ID:"123",MASTODON_ACCESS_TOKEN:"fixture-token",MASTODON_OUTBOUND_ORIGIN:"https://social.example"}};
}
const status = {id:"456",account:{id:"123"},visibility:"public",url:"https://social.example/@owner/456"};
test("Mastodon verifies the configured account before explicitly publishing only the body",async()=>{
 const f = await fixture(); const calls:{url:string;init:RequestInit}[] = [];
 const adapter = new MastodonOutbound({...f,fetch:async (url,init) => {
  calls.push({url:String(url),init:init!});
  assert.equal(init?.redirect,"error"); assert.equal(init?.cache,"no-store");
  assert.equal(new Headers(init?.headers).get("authorization"),"Bearer fixture-token");
  return Response.json(calls.length === 1 ? {id:"123"} : status);
 }});
 assert.equal(adapter.enabled,true);
 assert.deepEqual(await adapter.post({body:"hello",permalink:"https://private.example",tags:["private"]}),{ok:true,network:"Mastodon (ActivityPub)",url:status.url});
 assert.deepEqual(calls.map(c => c.url),["https://social.example/api/v1/accounts/verify_credentials","https://social.example/api/v1/statuses"]);
 assert.equal(calls[0].init.method,"GET"); assert.equal(calls[1].init.method,"POST");
 assert.deepEqual(JSON.parse(String(calls[1].init.body)),{status:"hello",visibility:"public"});
});
test("missing, leaked, wrong-owner and malformed configuration cannot use a token",async()=>{
 const f = await fixture();
 for(const options of [{...f,owner:undefined},{...f,owner:(await sea.pair()).pub},{...f,env:{}},
 {...f,env:{...f.env,NEXT_PUBLIC_MASTODON_ACCESS_TOKEN:"leaked"}},
 {...f,env:{...f.env,MASTODON_OUTBOUND_ACCOUNT_ID:"bad"}},
 ...["http://social.example","https://social.example/path","https://user:password@social.example"].map(origin=>({...f,env:{...f.env,MASTODON_OUTBOUND_ORIGIN:origin}}))]) {
  const adapter = new MastodonOutbound({...options,fetch:async()=>{assert.fail("no network");}});
  assert.equal(adapter.enabled,false); assert.equal((await adapter.post({body:"hello"})).ok,false);
 }
});
test("wrong provider account and configuration replacement never mutate",async()=>{
 for(const replace of [false,true]) {
  const f = await fixture(); let calls=0;
  const adapter = new MastodonOutbound({...f,fetch:async()=>{
   assert.equal(++calls,1);
   if(replace) f.env.MASTODON_ACCESS_TOKEN="replacement";
   return Response.json({id:replace ? "123" : "other"});
  }});
  assert.equal((await adapter.post({body:"hello"})).ok,false); assert.equal(calls,1);
 }
});
test("provider errors, wrong result accounts and unsafe URLs never report success or leak text",async()=>{
 const f = await fixture();
 for(const response of [new Response("fixture-secret",{status:401}),Response.json({...status,account:{id:"other"}}),
 Response.json({...status,url:"https://elsewhere.example/status"}),Response.json({...status,visibility:"private"}),Response.json({})]) {
  let calls=0;
  const adapter = new MastodonOutbound({...f,fetch:async()=>++calls === 1 ? Response.json({id:"123"}) : response});
  const result = await adapter.post({body:"hello"}); assert.equal(result.ok,false); assert.ok(!JSON.stringify(result).includes("fixture-secret"));
 }
});
test("oversized provider data is cancelled before any mutation",async()=>{
 const f=await fixture();let cancelled=false,calls=0;
 const adapter=new MastodonOutbound({...f,fetch:async()=>{
  calls++;return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(65537));},cancel(){cancelled=true;}}));
 }});
 assert.equal((await adapter.post({body:"hello"})).ok,false);assert.equal(calls,1);assert.equal(cancelled,true);
});
test("deadline and caller abort cancel stalled response bodies before mutation",async()=>{
 for(const callerAbort of [false,true]) {
  const f=await fixture();let cancelled=false,calls=0;const abort=new AbortController();
  const adapter=new MastodonOutbound({...f,timeoutMs:10,signal:abort.signal,fetch:async()=>{
   calls++;return new Response(new ReadableStream({start(){if(callerAbort) queueMicrotask(()=>abort.abort());},cancel(){cancelled=true;}}));
  }});
  assert.equal((await adapter.post({body:"hello"})).ok,false);assert.equal(calls,1);assert.equal(cancelled,true);
 }
});
test("invalid notes and already cancelled requests never fetch",async()=>{
 const f=await fixture();const abort=new AbortController();
 const adapter=new MastodonOutbound({...f,signal:abort.signal,fetch:async()=>{assert.fail("no network");}});
 for(const body of ["", "x".repeat(501), "\ud800"]) assert.equal((await adapter.post({body})).ok,false);
 abort.abort();assert.equal((await adapter.post({body:"hello"})).ok,false);
});
