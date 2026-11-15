import test from "node:test";
import assert from "node:assert/strict";
import { blueskyLiveProjection, blueskyProfileUrl, createBlueskyLiveDirectory } from "./bluesky-live";
const now = 1800000000, actor = "example.bsky.social", did = "did:plc:abcdefghijklmnopqrstuvwx";
const fixture = () => ({did,handle:actor,status:{status:"app.bsky.actor.status#live",isActive:true,isDisabled:false,
  record:{status:"app.bsky.actor.status#live",createdAt:new Date((now-60)*1000).toISOString()},
  expiresAt:new Date((now+3600)*1000).toISOString(),
  embed:{$type:"app.bsky.embed.external#view",external:{uri:"https://example.com/live",title:"Live fixture"}}}});
test("Bluesky links a followed publisher's player page with bounded observed expiry",()=>{
  assert.deepEqual(blueskyLiveProjection(fixture(),actor,now),{id:`bluesky:${did}`,author:did,title:"Live fixture",url:"https://example.com/live",starts:now-60,expires:now+300,playback:"external"});
  assert.equal(blueskyLiveProjection(fixture(),did,now)?.author,did);
  assert.equal(blueskyProfileUrl(actor).searchParams.get("actor"),actor);
  assert.equal(blueskyProfileUrl(actor).pathname,"/xrpc/app.bsky.actor.getProfile");
});
test("missing, ended, disabled, labelled and malformed live statuses are hidden",()=>{
  const mutations: Array<(p:any)=>void> = [
    p=>delete p.status,p=>p.status.isActive=false,p=>p.status.isDisabled=true,p=>delete p.status.isActive,
    p=>p.status.status="ended",p=>p.status.record.status="ended",p=>p.status.record=null,
    p=>p.labels=[{val:"!hide"}],p=>p.status.labels=[{val:"porn"}],p=>p.status.embed.$type="other",
    p=>p.status.expiresAt="invalid",p=>p.status.expiresAt=new Date(now*1000).toISOString(),
    p=>p.status.record.createdAt=new Date((now+1)*1000).toISOString(),
    p=>p.status.embed.external.uri="javascript:alert(1)",p=>p.status.embed.external.uri="https://localhost/live",
    p=>p.status.embed.external.uri="https://user:password@example.com/live",p=>p.status.embed.external.uri="http://example.com/live",
  ];
  for(const mutate of mutations){const p=fixture();mutate(p);assert.equal(blueskyLiveProjection(p,actor,now),null);}
  assert.throws(()=>blueskyLiveProjection({...fixture(),handle:"stranger.test"},actor,now));
  assert.throws(()=>blueskyLiveProjection({...fixture(),did:"not-a-did"},actor,now));
});
test("declared expiry is never extended by a successful poll",()=>{
  const p=fixture();p.status.expiresAt=new Date((now+10)*1000).toISOString();
  assert.equal(blueskyLiveProjection(p,actor,now)?.expires,now+10);
});
test("polling is shared and bounded; missing status immediately removes prior live entry",async()=>{
  let time=now*1000,calls=0,raw:unknown=fixture();
  const read=createBlueskyLiveDirectory([actor],async()=>{calls++;return raw;},()=>time);
  const [a,b]=await Promise.all([read(),read()]);assert.equal(calls,1);assert.deepEqual(a,b);assert.equal(a.streams.length,1);
  raw={did,handle:actor};time+=60_000;assert.deepEqual(await read(),{available:true,streams:[]});
  time+=60_000;assert.equal((await read()).streams.length,0);
});
test("failed and wrong-author responses cannot extend stale stream lifetime",async()=>{
  let time=now*1000,fail=false;
  const read=createBlueskyLiveDirectory([actor],async()=>{if(fail)throw Error("source down");return fixture();},()=>time);
  await read();fail=true;time+=60_000;const stale=await read();assert.equal(stale.available,false);assert.equal(stale.streams[0].expires,now+300);
  time=(now+300)*1000;assert.deepEqual(await read(),{available:false,streams:[]});
  const foreign=createBlueskyLiveDirectory([actor],async()=>({...fixture(),handle:"other.test"}),()=>time);
  assert.deepEqual(await foreign(),{available:false,streams:[]});
});
test("fixed source set rejects unbounded or duplicate actors",()=>{
  assert.throws(()=>createBlueskyLiveDirectory(Array(17).fill(actor)));
  assert.throws(()=>createBlueskyLiveDirectory([actor,actor]));
  assert.throws(()=>createBlueskyLiveDirectory(["https://caller.test/"]));
});
