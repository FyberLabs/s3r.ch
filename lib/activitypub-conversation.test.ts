import test from "node:test";
import assert from "node:assert/strict";
import {fetchActivityPubConversation,fetchActivityPubObject} from "./activitypub-conversation";
import type {FeedItem} from "./feed-types";
const id=(n:string)=>`https://example.com/posts/${n}`;
const note=(n:string,parent?:string)=>({id:id(n),type:"Note",attributedTo:"https://example.com/users/a",to:["https://www.w3.org/ns/activitystreams#Public"],content:n,...(parent?{inReplyTo:id(parent)}:{})});
const anchor={id:id("child"),source:"activitypub",kind:"social",author:"a",body:"child",ts:1,permalink:id("child"),tags:[],provenance:"fixture",replyTo:{id:id("parent"),permalink:id("parent")}} as FeedItem;
test("connected public ancestors and independently fetched replies only",async()=>{
 const data:Record<string,unknown>={
  [anchor.id]:{...note("child","parent"),replies:{type:"Collection",items:[{...note("reply","child"),content:"forged embedded body"},id("unrelated"),id("reply"),null]}},
  [id("parent")]:note("parent","root"),[id("root")]:note("root"),[id("reply")]:note("reply","child"),[id("unrelated")]:note("unrelated","other"),
 };let calls=0;
 const result=await fetchActivityPubConversation(anchor,async url=>{calls++;return data[url];});
 assert.deepEqual(result.rows.map(row=>row.id),["child","parent","root","reply"].map(id));assert.equal(result.rows[3].body,"reply");assert.equal(calls,5);assert.equal(result.truncated,false);
});
test("objects require public audience, matching identity and their own author authority",async()=>{
 for(const raw of [null,[],{...note("child"),id:id("other")},{...note("child"),type:"Tombstone"},{...note("child"),to:[]},{...note("child"),attributedTo:"https://foreign.example/user"},{...note("child"),attributedTo:null}])assert.deepEqual((await fetchActivityPubConversation(anchor,async()=>raw)).rows,[]);
 const cc={...note("child"),to:undefined,cc:"https://www.w3.org/ns/activitystreams#Public"};assert.equal((await fetchActivityPubConversation(anchor,async()=>cc)).rows.length,1);
 for(const invalid of [{...anchor,source:"nostr" as const},{...anchor,id:"http://127.0.0.1/private"},{...anchor,id:"x".repeat(2049)}])await fetchActivityPubConversation(invalid,async()=>{assert.fail("must not fetch");});
 assert.deepEqual((await fetchActivityPubConversation(anchor,async()=>{throw Error("offline");})).rows,[]);
 const missing=await fetchActivityPubConversation(anchor,async url=>url===anchor.id?note("child","parent"):{});assert.equal(missing.rows.length,1);
 const failed=await fetchActivityPubConversation(anchor,async url=>{if(url!==anchor.id)throw Error("private");return note("child","parent");});assert.equal(failed.rows.length,1);
});
test("reply collections stay on the anchor authority and one first page",async()=>{
 const collection="https://example.com/replies",page="https://example.com/replies?page=1";
 const data:Record<string,unknown>={[anchor.id]:{...note("child"),replies:collection},[collection]:{type:"OrderedCollection",first:page},[page]:{type:"OrderedCollectionPage",orderedItems:[id("reply")],next:"https://example.com/next"},[id("reply")]:note("reply","child")};
 const result=await fetchActivityPubConversation(anchor,async url=>data[url]);assert.equal(result.rows.length,2);assert.equal(result.truncated,true);
 for(const replies of ["https://foreign.example/replies",{type:"Collection",first:"https://foreign.example/page"},{type:"Collection",items:"invalid"},"http://127.0.0.1/private"]){let calls=0;const result=await fetchActivityPubConversation(anchor,async()=>{calls++;return {...note("child"),replies};});assert.equal(calls,1);assert.equal(result.rows.length,1);}
});
test("depth, cycles, reply counts, total requests and elapsed budget are bounded",async()=>{
 let calls=0;const result=await fetchActivityPubConversation(anchor,async url=>{
  calls++;if(url===anchor.id)return {...note("child","p1"),replies:{type:"Collection",items:Array.from({length:40},(_,n)=>id(`r${n}`))}};
  const n=url.split("/").pop()!;return n.startsWith("p")?note(n,`p${Number(n.slice(1))+1}`):note(n,"child");
 });assert.equal(calls,25);assert.equal(result.rows.length,25);assert.equal(result.truncated,true);
 const cycle=await fetchActivityPubConversation(anchor,async()=>note("child","child"));assert.equal(cycle.truncated,true);
 let now=0;const timed=await fetchActivityPubConversation(anchor,async()=>{now=15_000;return note("child","parent");},()=>now);assert.equal(timed.rows.length,1);assert.equal(timed.truncated,true);
 const exhausted=await fetchActivityPubConversation(anchor,async url=>{
  if(url===anchor.id)return {...note("child","p1"),replies:"https://example.com/replies"};
  if(url==="https://example.com/replies")return {type:"Collection",first:"https://example.com/page"};
  if(url==="https://example.com/page")return {type:"CollectionPage",items:Array.from({length:16},(_,n)=>id(`r${n}`))};
  const n=url.split("/").pop()!;return n.startsWith("p")?note(n,`p${Number(n.slice(1))+1}`):note(n,"child");
 });assert.equal(exhausted.rows.length,24);assert.equal(exhausted.truncated,true);
});
test("HTTP JSON reader checks final authority and rejects malformed JSON",async()=>{
 assert.deepEqual(await fetchActivityPubObject(anchor.id,async(url,options)=>{assert.ok(options?.accept?.includes("activity+json"));return {url:String(url),text:'{"type":"Note"}'};}),{type:"Note"});
 for(const url of ["","https://foreign.example/object"])await assert.rejects(fetchActivityPubObject(anchor.id,async()=>({url,text:"{}"})));
 await assert.rejects(fetchActivityPubObject(anchor.id,async()=>({url:anchor.id,text:"invalid"})));
});
