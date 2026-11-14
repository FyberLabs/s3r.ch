import {ATPROTO_APPVIEW_BASE,normalizeAtprotoPost} from "./atproto";
import {CONVERSATION_DEPTH,CONVERSATION_REPLIES} from "./feed-conversation";
import type {FeedItem} from "./feed-types";
import {fetchPublicJson} from "./public-fetch";
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
const POST_URI=/^at:\/\/did:(?:plc:[a-z2-7]{24}|web:[A-Za-z0-9._:%-]+)\/app\.bsky\.feed\.post\/[A-Za-z0-9._~-]{1,512}$/;
/** One bounded unauthenticated AppView request; no caller-selected endpoint. */
export async function fetchAtprotoConversation(anchor:FeedItem,pull=fetchPublicJson){
 const empty={rows:[] as FeedItem[],truncated:false};
 if(anchor.source!=="atproto"||anchor.id.length>2048||!POST_URI.test(anchor.id))return empty;
 const url=new URL("/xrpc/app.bsky.feed.getPostThread",ATPROTO_APPVIEW_BASE);
 url.searchParams.set("uri",anchor.id);url.searchParams.set("depth","1");url.searchParams.set("parentHeight",String(CONVERSATION_DEPTH));
 const response=record(await pull(url)),thread=record(response.thread);
 const post=(node:Record<string,unknown>)=>{
  if(node.blocked===true||node.notFound===true)return null;
  if(node.$type!==undefined&&node.$type!=="app.bsky.feed.defs#threadViewPost")return null;
  const value=record(node.post),author=record(value.author),content=record(value.record);
  if(typeof value.uri!=="string"||value.uri.length>2048||!POST_URI.test(value.uri)||typeof author.did!=="string"||!value.uri.startsWith(`at://${author.did}/app.bsky.feed.post/`)||content.$type!=="app.bsky.feed.post")return null;
  return normalizeAtprotoPost({post:node.post},`atproto:${url.href}`);
 };
 const current=post(thread);if(!current||current.id!==anchor.id)return empty;
 const rows=[current],seen=new Set([current.id]);let node=thread,cursor=current,truncated=false;
 for(let depth=0;depth<CONVERSATION_DEPTH&&cursor.replyTo;depth++){
  node=record(node.parent);const parent=post(node);
  if(!parent||parent.id!==cursor.replyTo.id)break;
  if(seen.has(parent.id)){truncated=true;break;}
  rows.push(parent);seen.add(parent.id);cursor=parent;
 }
 if(rows.length===CONVERSATION_DEPTH+1&&cursor.replyTo)truncated=true;
 const replies=Array.isArray(thread.replies)?thread.replies:[];
 if(replies.length>CONVERSATION_REPLIES)truncated=true;
 for(const raw of replies.slice(0,CONVERSATION_REPLIES+1)){
  const reply=post(record(raw));if(!reply||reply.replyTo?.id!==current.id||seen.has(reply.id))continue;
  seen.add(reply.id);rows.push(reply);
 }
 return {rows,truncated};
}
