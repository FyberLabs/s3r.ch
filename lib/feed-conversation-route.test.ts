import test from "node:test";
import assert from "node:assert/strict";
import {GET} from "../app/api/feed/conversation/route";
test("anonymous conversation route uses the configured peer and refuses invalid or unavailable inputs",async()=>{
 const oldPeer=process.env.S3RCH_GUN_HEALTH_URL,oldFetch=globalThis.fetch;let calls=0;
 process.env.S3RCH_GUN_HEALTH_URL="https://peer.example/api/health";
 globalThis.fetch=async input=>{calls++;assert.equal(String(input),"https://peer.example/feed-cache/snapshot.json");return Response.json({items:[{id:"1",source:"nostr",body:"Parent"},{id:"2",source:"nostr",body:"Reply",replyTo:{id:"1",permalink:"https://example.com/1"}}]});};
 const request=(query:string)=>new Request("https://s3r.ch/api/feed/conversation?"+query);
 try{
  for(let i=0;i<125;i++)assert.equal((await GET(request("source=unknown&id=1"))).status,400);
  assert.equal(calls,0);
  const response=await GET(request("source=nostr&id=2"));assert.equal(response.status,200);
  const body=await response.json();assert.deepEqual(body.items.map((item:{id:string})=>item.id),["1","2"]);assert.equal(calls,1);
  assert.equal((await GET(request("source=nostr&id=missing"))).status,404);
  process.env.S3RCH_GUN_HEALTH_URL="https://failed.example/api/health";globalThis.fetch=async()=>new Response(null,{status:503});
  assert.equal((await GET(request("source=nostr&id=2"))).status,503);
 }finally{globalThis.fetch=oldFetch;if(oldPeer===undefined)delete process.env.S3RCH_GUN_HEALTH_URL;else process.env.S3RCH_GUN_HEALTH_URL=oldPeer;}
});
