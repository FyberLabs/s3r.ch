import {ACTIVITYPUB_ACCEPT,normalizeActivityPubItem} from "./activitypub";
import {CONVERSATION_DEPTH,CONVERSATION_REPLIES} from "./feed-conversation";
import type {FeedItem} from "./feed-types";
import {fetchPublicText} from "./public-fetch";
import {assertPublicHttpUrl} from "./url-guard";
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
const publicUrl=(value:unknown)=>{try{return typeof value==="string"&&value.length<=2048?assertPublicHttpUrl(value).href:null;}catch{return null;}};
const PUBLIC="https://www.w3.org/ns/activitystreams#Public";
export async function fetchActivityPubObject(url:string,pull=fetchPublicText){
 const result=await pull(url,{accept:ACTIVITYPUB_ACCEPT});
 // Never let a redirect to another authority attest an object on this host.
 if(!result.url||new URL(result.url).origin!==new URL(url).origin)throw Error("ActivityPub authority changed");
 return JSON.parse(result.text) as unknown;
}
/** Fetch each object from its own authority, without credentials or signed GETs. */
export async function fetchActivityPubConversation(anchor:FeedItem,pull=fetchActivityPubObject,clock=Date.now){
 const rows:FeedItem[]=[],seen=new Set<string>();let requests=0,truncated=false;
 const started=clock(),empty=()=>({rows,truncated});
 if(anchor.source!=="activitypub"||publicUrl(anchor.id)!==anchor.id)return empty();
 const fetchObject=async(id:string)=>{
  if(!publicUrl(id)||seen.has(id))return null;
  if(requests>=26||clock()-started>=15_000){truncated=true;return null;}
  seen.add(id);requests++;
  try{return record(await pull(id));}catch(error){if(id===anchor.id)throw error;return null;}
 };
 const project=(raw:Record<string,unknown>,id:string)=>{
  if(raw.id!==id||!["Note","Article"].includes(String(raw.type)))return null;
  const author=publicUrl(raw.attributedTo);if(!author||new URL(author).origin!==new URL(id).origin)return null;
  const audience=[raw.to,raw.cc].flatMap(value=>Array.isArray(value)?value:[value]);
  if(!audience.includes(PUBLIC))return null;
  return normalizeActivityPubItem(raw,`activitypub:${id}`);
 };
 const raw=await fetchObject(anchor.id);if(!raw)return empty();
 const current=project(raw,anchor.id);if(!current)return empty();rows.push(current);
 let cursor=current;
 for(let depth=0;depth<CONVERSATION_DEPTH&&cursor.replyTo;depth++){
  const id=cursor.replyTo.id;
  if(seen.has(id)){truncated=true;break;}
  const parentRaw=await fetchObject(id);if(!parentRaw)break;
  const parent=project(parentRaw,id);if(!parent)break;
  rows.push(parent);cursor=parent;
 }
 if(rows.length===CONVERSATION_DEPTH+1&&cursor.replyTo)truncated=true;
 // Only the anchor authority can supply its reply collection. Child objects
 // are always re-fetched from their own authority, never trusted when embedded.
 let collection=record(raw.replies);
 const repliesUrl=publicUrl(raw.replies);
 if(repliesUrl&&new URL(repliesUrl).origin===new URL(anchor.id).origin)collection=await fetchObject(repliesUrl)??{};
 if(!["Collection","OrderedCollection","CollectionPage","OrderedCollectionPage"].includes(String(collection.type)))return empty();
 let entries=collection.orderedItems??collection.items;
 if(!Array.isArray(entries)){
  const first=publicUrl(collection.first);
  if(first&&new URL(first).origin===new URL(anchor.id).origin){collection=await fetchObject(first)??{};entries=collection.orderedItems??collection.items;}
 }
 if(!["Collection","OrderedCollection","CollectionPage","OrderedCollectionPage"].includes(String(collection.type))||!Array.isArray(entries))return empty();
 if(entries.length>CONVERSATION_REPLIES||collection.next)truncated=true;
 for(const entry of entries.slice(0,CONVERSATION_REPLIES)){
  const id=publicUrl(typeof entry==="string"?entry:record(entry).id);if(!id)continue;
  const replyRaw=await fetchObject(id);if(!replyRaw)continue;
  const reply=project(replyRaw,id);if(reply?.replyTo?.id===anchor.id)rows.push(reply);
 }
 return empty();
}
