import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readRoomAuthorityConfig } from "./room-authority-config";
const config={authorityEndpoint:"/api/squad/pilot/authority",sessionBase:"/api/identity/sea",squad:{},config:{}};
test("runtime room configuration uses a fixed same-origin authenticated uncached request",async()=>{
 const signal=new AbortController().signal;
 const result=await readRoomAuthorityConfig(signal,async(url,options)=>{
  assert.equal(url,"/api/squad/pilot/room-config");
  assert.equal(options?.credentials,"same-origin");assert.equal(options?.mode,"same-origin");
  assert.equal(options?.redirect,"error");assert.equal(options?.cache,"no-store");assert.equal(options?.signal,signal);
  return Response.json({config});
 });
 assert.deepEqual(result,config);
});
test("missing, redirected, invalid and aborted configuration never creates authority",async()=>{
 for(const status of [401,404,503]) assert.equal(await readRoomAuthorityConfig(new AbortController().signal,async()=>new Response(null,{status})),null);
 for(const value of [null,{}, {...config,authorityEndpoint:"https://elsewhere.test/authority"},{...config,sessionBase:"/wrong"}])
  assert.equal(await readRoomAuthorityConfig(new AbortController().signal,async()=>Response.json({config:value})),null);
 const aborted=new AbortController();
 await assert.rejects(readRoomAuthorityConfig(aborted.signal,async()=>{aborted.abort();return Response.json({config});}));
 assert.equal(await readRoomAuthorityConfig(new AbortController().signal,async()=>Object.defineProperty(Response.json({config}),"redirected",{value:true})),null);
});
test("feed remains a static shell and public config stays behind the authenticated runtime route",()=>{
 const page=readFileSync(new URL("../app/feed/page.tsx",import.meta.url),"utf8");
 assert.doesNotMatch(page,/force-dynamic|process\.env|parseSquadPilotConfig/);
 assert.match(page,/<RoomAuthorityProvider><FeedStream/);
 const route=readFileSync(new URL("../app/api/squad/pilot/[...path]/route.ts",import.meta.url),"utf8");
 assert.match(route,/room-config[\s\S]*readSeaRequestSession\(request\)[\s\S]*publicSquadPilotConfig\(config\)/);
 assert.match(route,/"Cache-Control": "no-store"/);
});


test("configuration responses are bounded JSON and aborted requests never fetch",async()=>{
 const aborted=new AbortController();aborted.abort();let fetched=false;
 await assert.rejects(readRoomAuthorityConfig(aborted.signal,async()=>{fetched=true;return Response.json({config});}));
 assert.equal(fetched,false);
 assert.equal(await readRoomAuthorityConfig(new AbortController().signal,async()=>new Response(JSON.stringify({config}),{headers:{"Content-Type":"text/html"}})),null);
 await assert.rejects(readRoomAuthorityConfig(new AbortController().signal,async()=>new Response("x".repeat(32769),{headers:{"Content-Type":"application/json"}})),/too large/);
 await assert.rejects(readRoomAuthorityConfig(new AbortController().signal,async()=>new Response("not json",{headers:{"Content-Type":"application/json"}})));
});
