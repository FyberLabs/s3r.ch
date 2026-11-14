import {FARCASTER_HUB_BASE,normalizeHubCast,type HubCastMessage} from "./farcaster";
import {fetchPublicJson} from "./public-fetch";
import type {FeedItem} from "./feed-types";
import {CONVERSATION_DEPTH,CONVERSATION_REPLIES} from "./feed-conversation";
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
const validHash=(value:unknown):value is string=>typeof value==="string"&&/^0x[a-f0-9]{40}$/.test(value);
const validFid=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>0;
const endpoint=(name:string)=>new URL(`${FARCASTER_HUB_BASE.replace(/\/$/,"")}/v1/${name}`);
/** FID comes from the existing trusted public seed provenance, never an arbitrary URL lookup. */
export function farcasterAnchorFid(anchor:FeedItem){
 if(anchor.source!=="farcaster"||!validHash(anchor.id))return null;
 try{
  if(!anchor.provenance.startsWith("farcaster:hub:"))return null;
  const source=new URL(anchor.provenance.slice("farcaster:hub:".length)),expected=endpoint("castsByFid");
  if(source.origin!==expected.origin||source.pathname!==expected.pathname||source.searchParams.getAll("fid").length!==1)return null;
  const text=source.searchParams.get("fid")!;if(!/^[1-9][0-9]{0,15}$/.test(text))return null;
  const fid=Number(text);return validFid(fid)?fid:null;
 }catch{return null;}
}
export async function fetchFarcasterConversation(anchor:FeedItem,pull=fetchPublicJson,clock=Date.now){
 const rows:FeedItem[]=[],seen=new Set<string>();let truncated=false;
 const fid=farcasterAnchorFid(anchor);if(fid===null)return {rows,truncated};
 const started=clock();
 const query=async(name:string,fid:number,hash:string)=>{
  if(clock()-started>=15_000){truncated=true;return null;}
  const url=endpoint(name);url.searchParams.set("fid",String(fid));url.searchParams.set("hash",hash);
  if(name==="castsByParent")url.searchParams.set("pageSize",String(CONVERSATION_REPLIES+1));
  return record(await pull(url));
 };
 const project=(raw:Record<string,unknown>,fid?:number,hash?:string)=>{
  const data=record(raw.data);if(!validHash(raw.hash)||!validFid(data.fid)||(fid!==undefined&&data.fid!==fid)||(hash!==undefined&&raw.hash!==hash)||data.type!=="MESSAGE_TYPE_CAST_ADD")return null;
  const item=normalizeHubCast(raw as HubCastMessage,null,`farcaster:hub:${endpoint("castById")}`);return item?{item,data}:null;
 };
 const raw=await query("castById",fid,anchor.id);let current=raw?project(raw,fid,anchor.id):null;
 if(!current)return {rows,truncated};rows.push(current.item);seen.add(current.item.id);
 for(let depth=0;depth<CONVERSATION_DEPTH;depth++){
  const parent=record(record(current.data.castAddBody).parentCastId);
  if(!validFid(parent.fid)||!validHash(parent.hash))break;
  if(seen.has(parent.hash)){truncated=true;break;}
  let fetched;try{fetched=await query("castById",parent.fid,parent.hash);}catch{break;}
  const next=fetched?project(fetched,parent.fid,parent.hash):null;if(!next)break;
  rows.push(next.item);seen.add(next.item.id);current=next;
 }
 if(rows.length===CONVERSATION_DEPTH+1&&current.item.replyTo)truncated=true;
 try{
  const response=await query("castsByParent",fid,anchor.id),messages=response?.messages;
  if(Array.isArray(messages)){
   if(messages.length>CONVERSATION_REPLIES||response?.nextPageToken)truncated=true;
   for(const message of messages.slice(0,CONVERSATION_REPLIES+1)){
    const reply=project(record(message));if(!reply)continue;
    const parent=record(record(reply.data.castAddBody).parentCastId);
    if(parent.fid!==fid||parent.hash!==anchor.id||seen.has(reply.item.id))continue;
    seen.add(reply.item.id);rows.push(reply.item);
   }
  }
 }catch{/* Keep the available ancestor chain when replies are unavailable. */}
 return {rows,truncated};
}
