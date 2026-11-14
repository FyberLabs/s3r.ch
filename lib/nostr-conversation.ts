import {queryNostrRelay,NOSTR_RELAY_URL,normalizeNostrEvent} from "./nostr";
import {verifiedNostrEvent} from "./nostr-event";
import type {NostrFilter} from "./nostr-filter";
import type {FeedItem} from "./feed-types";
import {CONVERSATION_DEPTH,CONVERSATION_REPLIES} from "./feed-conversation";
const valid=(id:string)=>/^[a-f0-9]{64}$/.test(id);
/** Fixed configured relay only. References never select another relay or fetch URL. */
export async function fetchNostrConversation(anchor:FeedItem,pull=queryNostrRelay,clock=Date.now){
 const rows:FeedItem[]=[],seen=new Set<string>();let truncated=false;
 if(anchor.source!=="nostr"||!valid(anchor.id))return {rows,truncated};
 const started=clock(),now=Math.floor(started/1000);
 const query=async(filter:NostrFilter)=>{
  if(clock()-started>=15_000){truncated=true;return [];}
  const events=await pull(NOSTR_RELAY_URL,filter),items:FeedItem[]=[];
  if(events.length>filter.limit)throw Error("Nostr conversation window exceeds limit");
  for(const raw of events){
   const author=raw&&typeof raw==="object"?(raw as {pubkey?:unknown}).pubkey:null;
   const event=await verifiedNostrEvent(raw,typeof author==="string"?[author]:[],1,now);
   if(!event)continue;
   if(filter.ids&&!filter.ids.includes(event.id))continue;
   const item=normalizeNostrEvent(event,`nostr:relay:${NOSTR_RELAY_URL}`);if(item)items.push(item);
  }
  return items;
 };
 let current=(await query({ids:[anchor.id],kinds:[1],limit:1}))[0];
 if(!current)return {rows,truncated};rows.push(current);seen.add(current.id);
 for(let depth=0;depth<CONVERSATION_DEPTH&&current.replyTo;depth++){
  const id=current.replyTo.id;if(!valid(id))break;if(seen.has(id)){truncated=true;break;}
  let parent:FeedItem|undefined;try{parent=(await query({ids:[id],kinds:[1],limit:1}))[0];}catch{break;}
  if(!parent)break;rows.push(parent);seen.add(parent.id);current=parent;
 }
 if(rows.length===CONVERSATION_DEPTH+1&&current.replyTo)truncated=true;
 try{
  const replies=await query({"#e":[anchor.id],kinds:[1],limit:CONVERSATION_REPLIES+1});
  for(const reply of replies){if(reply.replyTo?.id!==anchor.id||seen.has(reply.id))continue;seen.add(reply.id);rows.push(reply);}
  if(replies.length>CONVERSATION_REPLIES)truncated=true;
 }catch{/* Keep authenticated ancestors when the reply window is unavailable. */}
 return {rows,truncated};
}
