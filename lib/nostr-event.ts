import {schnorr} from "@noble/curves/secp256k1.js";
export type NostrEvent={id:string;pubkey:string;created_at:number;kind:number;tags:string[][];content:string;sig:string};
const bytes=(hex:string)=>Uint8Array.from(hex.match(/../g)!,value=>parseInt(value,16));
const hex=(value:Uint8Array)=>Array.from(value,n=>n.toString(16).padStart(2,"0")).join("");
/** Bounded NIP-01 authentication shared by server pulls and browser-safe adapters. */
export async function verifiedNostrEvent(raw:unknown,authors:readonly string[],kind:number,now:number,maxAge=Infinity):Promise<NostrEvent|null>{
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
 const e=raw as NostrEvent,hex64=/^[a-f0-9]{64}$/;
 if(e.kind!==kind||typeof e.pubkey!=="string"||!hex64.test(e.pubkey)||!authors.includes(e.pubkey)||
  typeof e.id!=="string"||!hex64.test(e.id)||typeof e.sig!=="string"||!/^[a-f0-9]{128}$/.test(e.sig)||
  !Number.isSafeInteger(e.created_at)||e.created_at<0||e.created_at<=now-maxAge||e.created_at>now+60||
  typeof e.content!=="string"||e.content.length>16384||!e.content.isWellFormed()||
  !Array.isArray(e.tags)||e.tags.length>128||e.tags.some(t=>!Array.isArray(t)||!t.length||t.length>8||t.some(s=>typeof s!=="string"||s.length>2048||!s.isWellFormed())))return null;
 const event:NostrEvent={id:e.id,pubkey:e.pubkey,created_at:e.created_at,kind:e.kind,tags:e.tags.map(tag=>[...tag]),content:e.content,sig:e.sig};
 try {
  const payload=new TextEncoder().encode(JSON.stringify([0,event.pubkey,event.created_at,event.kind,event.tags,event.content]));
  const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",payload));
  if(hex(hash)!==event.id||!schnorr.verify(bytes(event.sig),hash,bytes(event.pubkey)))return null;
 }catch{return null;}
 return event;
}
