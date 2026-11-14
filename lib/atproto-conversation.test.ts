import test from "node:test";
import assert from "node:assert/strict";
import {fetchAtprotoConversation} from "./atproto-conversation";
import type {FeedItem} from "./feed-types";
const did="did:plc:"+"a".repeat(24),uri=(id:string)=>`at://${did}/app.bsky.feed.post/${id}`;
const anchor={id:uri("child"),source:"atproto",kind:"social",author:"a.test",body:"Child",ts:1,permalink:"https://bsky.app/profile/a.test/post/child",tags:[],provenance:"fixture",replyTo:{id:uri("parent"),permalink:"https://bsky.app/profile/a.test/post/parent"}} as FeedItem;
function view(id:string,parent?:string){return {$type:"app.bsky.feed.defs#threadViewPost",post:{uri:uri(id),author:{did,handle:"a.test"},record:{$type:"app.bsky.feed.post",text:id,createdAt:"2026-01-01T00:00:00Z",...(parent?{reply:{parent:{uri:uri(parent)},root:{uri:uri("root")}}}:{})}}};}
test("one public AppView request admits only connected ancestors and direct replies",async()=>{
 let calls=0;const result=await fetchAtprotoConversation(anchor,async target=>{
  calls++;const url=new URL(String(target));assert.equal(url.pathname,"/xrpc/app.bsky.feed.getPostThread");assert.equal(url.searchParams.get("uri"),anchor.id);assert.equal(url.searchParams.get("depth"),"1");assert.equal(url.searchParams.get("parentHeight"),"8");
  return {thread:{...view("child","parent"),parent:{...view("parent","root"),parent:view("root")},replies:[view("reply","child"),view("foreign","other"),view("reply","child")]}};
 });
 assert.equal(calls,1);assert.deepEqual(result.rows.map(r=>r.id),["child","parent","root","reply"].map(uri));assert.equal(result.truncated,false);
});
test("missing, blocked, mismatched and malformed objects are not admitted",async()=>{
 for(const thread of [null,{$type:"app.bsky.feed.defs#blockedPost"}, {...view("child"),blocked:true},{...view("child"),notFound:true},view("other"),{post:{}}, {...view("child"),post:{...view("child").post,author:{did:"foreign"}}}])assert.deepEqual((await fetchAtprotoConversation(anchor,async()=>({thread}))).rows,[]);
 const result=await fetchAtprotoConversation(anchor,async()=>({thread:{...view("child","parent"),parent:view("wrong")}}));assert.equal(result.rows.length,1);
 for(const item of [{...anchor,source:"nostr" as const},{...anchor,id:"https://attacker.example/post"},{...anchor,id:"x".repeat(2049)}])assert.deepEqual((await fetchAtprotoConversation(item,async()=>{assert.fail("no request");})).rows,[]);
 await assert.rejects(fetchAtprotoConversation(anchor,async()=>{throw Error("rate limited");}));
});
test("depth, cycles and reply counts are bounded",async()=>{
 let parent:unknown=view("p10");for(let n=9;n>=1;n--)parent={...view(`p${n}`,`p${n+1}`),parent};
 const long=await fetchAtprotoConversation(anchor,async()=>({thread:{...view("child","p1"),parent,replies:Array.from({length:30},(_,n)=>view(`r${n}`,"child"))}}));
 assert.equal(long.rows.length,26);assert.equal(long.truncated,true);
 const cycle=await fetchAtprotoConversation(anchor,async()=>({thread:{...view("child","child"),parent:view("child")}}));assert.equal(cycle.rows.length,1);assert.equal(cycle.truncated,true);
});
