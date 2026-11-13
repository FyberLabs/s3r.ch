import {createHash} from "node:crypto";
import {schnorr} from "@noble/curves/secp256k1.js";
import {publicMediaUrl} from "./feed-media";
import {NOSTR_RELAY_URL,PUBLIC_NOSTR_PUBKEYS,queryNostrRelay} from "./nostr";
export const LIVE_MAX_AGE=3600;
export type PublicLiveStream={id:string;author:string;title:string;url:string;thumbnail?:string;participants?:number;starts:number;expires:number};
type LiveEvent={id:string;pubkey:string;created_at:number;kind:number;tags:string[][];content:string;sig:string};
/** NIP-01 authentication precedes NIP-53 address replacement and display. */
export function verifiedLiveEvent(raw:unknown,authors:readonly string[],now:number):LiveEvent|null {
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
 const e=raw as LiveEvent,hex=/^[a-f0-9]{64}$/;
 if(e.kind!==30311||typeof e.pubkey!=="string"||!hex.test(e.pubkey)||!authors.includes(e.pubkey)||
  typeof e.id!=="string"||!hex.test(e.id)||typeof e.sig!=="string"||!/^[a-f0-9]{128}$/.test(e.sig)||
  !Number.isSafeInteger(e.created_at)||e.created_at<=now-LIVE_MAX_AGE||e.created_at>now+60||
  typeof e.content!=="string"||e.content.length>16384||!e.content.isWellFormed()||
  !Array.isArray(e.tags)||e.tags.length>128||e.tags.some(t=>!Array.isArray(t)||!t.length||t.length>8||t.some(s=>typeof s!=="string"||s.length>2048||!s.isWellFormed())))return null;
 const hash=createHash("sha256").update(JSON.stringify([0,e.pubkey,e.created_at,e.kind,e.tags,e.content])).digest();
 try {if(hash.toString("hex")!==e.id||!schnorr.verify(Buffer.from(e.sig,"hex"),hash,Buffer.from(e.pubkey,"hex")))return null;}catch{return null;}
 return e;
}
const tag=(event:LiveEvent,key:string)=>{const rows=event.tags.filter(t=>t[0]===key);return rows.length===1?rows[0][1]:undefined;};
const numeric=(value:string|undefined)=>value&&/^\d{1,13}$/.test(value)?Number(value):undefined;
export function liveAddress(event:LiveEvent):string|null {
 const d=tag(event,"d");return d!==undefined&&d.length<=256?`30311:${event.pubkey}:${d}`:null;
}
export function liveProjection(event:LiveEvent,now:number):PublicLiveStream|null {
 const id=liveAddress(event),url=publicMediaUrl(tag(event,"streaming"));
 if(!id||tag(event,"status")!=="live"||event.created_at<=now-LIVE_MAX_AGE||event.created_at>now+60||!url)return null;
 const starts=numeric(tag(event,"starts"))??event.created_at,ends=numeric(tag(event,"ends"));
 if(starts>now||ends!==undefined&&ends<=now)return null;
 const title=tag(event,"title")?.slice(0,256)||"Live stream",thumbnail=publicMediaUrl(tag(event,"image"));
 const participants=numeric(tag(event,"current_participants"));
 return {id,author:event.pubkey,title,url,starts,expires:Math.min(event.created_at+LIVE_MAX_AGE,ends??Infinity),
  ...(thumbnail?{thumbnail}:{}),...(participants!==undefined&&participants<=10_000_000?{participants}:{})};
}
/** Fixed followed authors; bounded shared polling, no caller-supplied relays or principals. */
export function createLiveDirectory(authors:readonly string[]=PUBLIC_NOSTR_PUBKEYS,
 pull:(author:string)=>Promise<unknown[]>=author=>queryNostrRelay(NOSTR_RELAY_URL,{authors:[author],kinds:[30311],limit:20}),clock=Date.now){
 if(!authors.length||authors.length>16||authors.some(a=>!/^[a-f0-9]{64}$/.test(a)))throw Error("Invalid live authors");
 const followed=[...authors],latest=new Map<string,LiveEvent>();let until=0,pending:Promise<void>|null=null,available=false;
 const update=async()=>{
  const results=await Promise.allSettled(followed.map(author=>Promise.resolve().then(()=>pull(author))));
  const now=Math.floor(clock()/1000);
  for(const [id,event] of latest)if(event.created_at<=now-LIVE_MAX_AGE)latest.delete(id);
  available=results.some(r=>r.status==="fulfilled");
  for(const result of results){if(result.status!=="fulfilled"||result.value.length>100)continue;
   for(const raw of result.value){const event=verifiedLiveEvent(raw,followed,now);if(!event)continue;
    const address=liveAddress(event);if(!address)continue;const prior=latest.get(address);
    // Retain ended markers until expiry; capacity cannot make stale live events win.
    if(!prior&&latest.size>=1600)continue;
    if(!prior||event.created_at>prior.created_at||event.created_at===prior.created_at&&event.id<prior.id)latest.set(address,event);
   }
  }
 };
 return async()=>{
  if(!pending&&clock()>=until){until=clock()+60_000;pending=update().finally(()=>{pending=null;});}
  await pending;const now=Math.floor(clock()/1000);
  for(const [id,event] of latest)if(event.created_at<=now-LIVE_MAX_AGE)latest.delete(id);
  return {available,streams:[...latest.values()].map(event=>liveProjection(event,now)).filter((s):s is PublicLiveStream=>s!==null).sort((a,b)=>b.starts-a.starts).slice(0,100)};
 };
}
export const publicLiveDirectory=createLiveDirectory();
