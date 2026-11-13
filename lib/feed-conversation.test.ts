import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {cachedConversation,CONVERSATION_DEPTH,CONVERSATION_REPLIES} from "./feed-conversation";
import type {FeedItem,FeedSource} from "./feed-types";
import FeedConversation,{ConversationView} from "../components/FeedConversation";
const row=(id:string,source:FeedSource,parent?:string):FeedItem=>({id,source,author:id,body:`body-${id}`,kind:"social",ts:Number(id)||0,permalink:`https://example.com/${id}`,tags:[],provenance:"fixture",...(parent?{replyTo:{id:parent,permalink:`https://example.com/${parent}`,author:parent}}:{})});
test("each provider renders a linked parent marker and ordered cached thread",()=>{
 for(const source of ["atproto","farcaster","nostr","activitypub"] as const){
  const items=[row("1",source),row("2",source,"1"),row("3",source,"2"),row("4",source,"3")];
  const conversation=cachedConversation(items,source,"3");assert.ok(conversation);
  assert.deepEqual(conversation.items.map(item=>item.id),["1","2","3"]);assert.deepEqual(conversation.replies.map(item=>item.id),["4"]);
  const marker=renderToStaticMarkup(createElement(FeedConversation,{item:items[2]}));assert.match(marker,/Replying to @2/);assert.match(marker,/href="https:\/\/example.com\/2"/);
  const html=renderToStaticMarkup(createElement(ConversationView,{conversation}));assert.ok(html.indexOf("body-1")<html.indexOf("body-2"));assert.ok(html.indexOf("body-3")<html.indexOf("body-4"));
 }
});
test("missing parents stay visible and unrelated sources cannot supply them",()=>{
 const items=[row("2","nostr","1"),row("1","atproto")];const conversation=cachedConversation(items,"nostr","2");assert.ok(conversation);
 assert.equal(conversation.missingParent?.id,"1");assert.match(renderToStaticMarkup(createElement(ConversationView,{conversation})),/Post unavailable/);
 assert.equal(cachedConversation(items,"nostr","missing"),null);
});
test("depth, direct reply count and cycles are bounded",()=>{
 const items=Array.from({length:30},(_,i)=>row(String(i),"nostr",i?String(i-1):undefined));
 const conversation=cachedConversation(items,"nostr","29");assert.ok(conversation);assert.equal(conversation.items.length,CONVERSATION_DEPTH+1);assert.equal(conversation.truncated,true);
 const replies=[row("root","nostr"),...Array.from({length:30},(_,i)=>row(String(i),"nostr","root"))];
 assert.equal(cachedConversation(replies,"nostr","root")?.replies.length,CONVERSATION_REPLIES);
 assert.equal(cachedConversation([row("1","nostr","2"),row("2","nostr","1")],"nostr","1")?.truncated,true);
});
