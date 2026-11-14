import test from "node:test";
import assert from "node:assert/strict";
import {farcasterAnchorFid,fetchFarcasterConversation} from "./farcaster-conversation";
import {FARCASTER_HUB_BASE} from "./farcaster";
import type {FeedItem} from "./feed-types";
const hash=(n:number)=>"0x"+n.toString(16).padStart(40,"0");
const cast=(n:number,parent?:number,fid=2)=>({hash:hash(n),data:{fid,type:"MESSAGE_TYPE_CAST_ADD",timestamp:123,castAddBody:{text:`cast ${n}`,...(parent?{parentCastId:{fid:2,hash:hash(parent)}}:{})}}});
const anchor={id:hash(3),source:"farcaster",kind:"social",author:"fixture",body:"child",ts:1,permalink:`https://farcaster.xyz/~/conversations/${hash(3)}`,tags:[],provenance:`farcaster:hub:${FARCASTER_HUB_BASE}/v1/castsByFid?fid=2&pageSize=20`} as FeedItem;
test("anchor FID requires the configured hub seed provenance and a full hash",()=>{
 assert.equal(farcasterAnchorFid(anchor),2);
 for(const change of [{source:"nostr"},{id:"bad"},{provenance:"bad"},{provenance:"farcaster:hub:not a url"},{provenance:"farcaster:hub:https://foreign.example/v1/castsByFid?fid=2"},{provenance:`farcaster:hub:${FARCASTER_HUB_BASE}/v1/castById?fid=2`},...['','?fid=0','?fid=-1','?fid=2&fid=3','?fid=2e3','?fid=9007199254740992'].map(query=>({provenance:`farcaster:hub:${FARCASTER_HUB_BASE}/v1/castsByFid${query}`}))])assert.equal(farcasterAnchorFid({...anchor,...change} as FeedItem),null);
});
test("one configured hub returns connected FID/hash ancestors and direct replies",async()=>{
 const calls:URL[]=[];const result=await fetchFarcasterConversation(anchor,async target=>{
  const url=new URL(String(target));calls.push(url);assert.equal(url.origin,new URL(FARCASTER_HUB_BASE).origin);assert.equal(url.searchParams.get("fid"),"2");
  if(url.pathname.endsWith("castsByParent")){assert.equal(url.searchParams.get("pageSize"),"17");return {messages:[cast(4,3),cast(4,3),cast(5,9),{...cast(6,3),data:{...cast(6,3).data,castAddBody:{parentCastId:{fid:7,hash:hash(3)}}}}]};}
  const n=Number(BigInt(url.searchParams.get("hash")!));return cast(n,n>1?n-1:undefined);
 });assert.deepEqual(result.rows.map(row=>row.id),[3,2,1,4].map(hash));assert.equal(calls.length,4);assert.equal(result.truncated,false);
});
test("missing, malformed and mismatched messages preserve partial context",async()=>{
 for(const raw of [null,[],{},cast(9),cast(3,2,7),{...cast(3),data:{...cast(3).data,type:"MESSAGE_TYPE_CAST_REMOVE"}}])assert.deepEqual((await fetchFarcasterConversation(anchor,async()=>raw)).rows,[]);
 await fetchFarcasterConversation({...anchor,id:"invalid"},async()=>{assert.fail("no request");});
 await assert.rejects(fetchFarcasterConversation(anchor,async()=>{throw Error("offline");}));
 const partial=await fetchFarcasterConversation(anchor,async target=>{if(new URL(String(target)).searchParams.get("hash")===anchor.id&&String(target).includes("castById"))return cast(3,2);throw Error("unavailable");});assert.equal(partial.rows.length,1);
 const malformed=await fetchFarcasterConversation(anchor,async target=>String(target).includes("castsByParent")?{messages:[{}, {hash:"bad",data:{fid:2}}]}:cast(3,2));assert.equal(malformed.rows.length,1);
});
test("depth, cycles, pagination, reply limits and elapsed budget are bounded",async()=>{
 const deep={...anchor,id:hash(20)};let calls=0;
 const result=await fetchFarcasterConversation(deep,async target=>{
  calls++;const url=new URL(String(target));if(url.pathname.endsWith("castsByParent"))return {messages:Array.from({length:40},(_,n)=>cast(100+n,20)),nextPageToken:"more"};
  const n=Number(BigInt(url.searchParams.get("hash")!));return cast(n,n-1);
 });assert.equal(result.rows.length,26);assert.equal(calls,10);assert.equal(result.truncated,true);
 const cycle=await fetchFarcasterConversation(anchor,async target=>String(target).includes("castsByParent")?{messages:[]}:cast(3,3));assert.equal(cycle.rows.length,1);assert.equal(cycle.truncated,true);
 let now=0;const timed=await fetchFarcasterConversation(anchor,async()=>{now=15_000;return cast(3,2);},()=>now);assert.equal(timed.rows.length,1);assert.equal(timed.truncated,true);
});
