export type NostrFilter={authors?:string[];ids?:string[];"#e"?:string[];kinds:number[];limit:number};
const keys=(value:unknown)=>Array.isArray(value)&&value.length>0&&value.length<=16&&value.every(v=>typeof v==="string"&&/^[a-f0-9]{64}$/i.test(v));
/** Every query has an explicit bounded author, event ID or event-reference selector. */
export function boundedNostrFilter(filter:NostrFilter):NostrFilter{
 const selectors=["authors","ids","#e"] as const;
 if(!selectors.some(key=>filter[key]!==undefined)||selectors.some(key=>filter[key]!==undefined&&!keys(filter[key]))||
  !Array.isArray(filter.kinds)||!filter.kinds.length||filter.kinds.length>8||filter.kinds.some(kind=>!Number.isSafeInteger(kind)||kind<0||kind>65535)||
  !Number.isSafeInteger(filter.limit)||filter.limit<1||filter.limit>100)throw Error("Invalid Nostr window filter");
 return {kinds:[...filter.kinds],limit:filter.limit,...Object.fromEntries(selectors.filter(key=>filter[key]!==undefined).map(key=>[key,filter[key]!.map(value=>value.toLowerCase())]))};
}
export function matchesNostrFilter(event:Record<string,unknown>,filter:NostrFilter){
 if(typeof event.pubkey!=="string"||typeof event.kind!=="number"||!filter.kinds.includes(event.kind))return false;
 if(filter.authors&&!filter.authors.includes(event.pubkey.toLowerCase()))return false;
 if(filter.ids&&(typeof event.id!=="string"||!filter.ids.includes(event.id.toLowerCase())))return false;
 if(filter["#e"]&&(!Array.isArray(event.tags)||event.tags.length>128||!event.tags.some(tag=>Array.isArray(tag)&&tag[0]==="e"&&typeof tag[1]==="string"&&filter["#e"]!.includes(tag[1].toLowerCase()))))return false;
 return true;
}
