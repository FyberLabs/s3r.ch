import test from "node:test";
import assert from "node:assert/strict";
import {createPublicConversations} from "./public-conversation";
import type {FeedItem} from "./feed-types";
const item=(id:string,parent?:string):FeedItem=>({id,source:"atproto",kind:"social",author:"a",body:id,ts:1,permalink:"https://example.com/"+id,tags:[],provenance:"fixture",...(parent?{replyTo:{id:parent,permalink:"https://example.com/"+parent}}:{})});
test("only visible anchors fetch; cache and single-flight remain bounded and refresh",async()=>{
 let now=0,calls=0;const rows=[item("child","parent")];
 const load=createPublicConversations(async()=>{calls++;return {rows:[item("parent"),item("child","parent"),item("reply","child")],truncated:false};},()=>now);
 assert.equal(await load(rows,"atproto","unknown"),null);assert.equal(calls,0);
 const [a,b]=await Promise.all([load(rows,"atproto","child"),load(rows,"atproto","child")]);assert.equal(calls,1);assert.deepEqual(a,b);assert.equal(a?.missingParent,null);assert.deepEqual(a?.items.map(i=>i.id),["parent","child"]);assert.equal(a?.replies.length,1);
 await load(rows,"atproto","child");assert.equal(calls,1);now=60_001;await load(rows,"atproto","child");assert.equal(calls,2);
 assert.equal(await load([],"atproto","child"),null);
 const other={...rows[0],source:"rss" as const};assert.ok(await load([other],"rss","child"));assert.equal(calls,2);
});
test("provider failures preserve placeholders and use a short negative cache",async()=>{
 let now=0,calls=0;const rows=[item("child","missing")];
 const load=createPublicConversations(async()=>{calls++;throw Error("offline");},()=>now);
 assert.equal((await load(rows,"atproto","child"))?.missingParent?.id,"missing");await load(rows,"atproto","child");assert.equal(calls,1);
 now=15_001;await load(rows,"atproto","child");assert.equal(calls,2);
});
test("excess work falls back without unbounded polling and cache evicts old keys",async()=>{
 let resolve!:(value:{rows:FeedItem[];truncated:boolean})=>void,calls=0;
 const blocked=new Promise<{rows:FeedItem[];truncated:boolean}>(done=>{resolve=done;});
 const load=createPublicConversations(async()=>{calls++;return blocked;});
 const pending=Array.from({length:4},(_,i)=>load([item(String(i))],"atproto",String(i)));
 assert.ok(await load([item("extra")],"atproto","extra"));assert.equal(calls,4);resolve({rows:[],truncated:true});assert.ok((await Promise.all(pending)).every(c=>c?.truncated));
 let fetched=0,cacheClock=0;const cached=createPublicConversations(async()=>{fetched++;return {rows:[],truncated:false};},()=>cacheClock);
 for(let n=0;n<65;n++){cacheClock=n*60_001;await cached([item(String(n))],"atproto",String(n));}
 await cached([item("0")],"atproto","0");assert.equal(fetched,66);
});

test("cold source requests have a shared minute budget while cached reads continue",async()=>{
 let now=0,calls=0;const load=createPublicConversations(async()=>{calls++;return {rows:[],truncated:false};},()=>now);
 for(let n=0;n<31;n++)await load([item(String(n))],"atproto",String(n));
 assert.equal(calls,30);assert.ok(await load([item("0")],"atproto","0"));assert.equal(calls,30);
 now=60_000;const ap={...item("ap"),source:"activitypub" as const};assert.ok(await load([ap],"activitypub","ap"));assert.equal(calls,31);
});
