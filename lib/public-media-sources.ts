import {mediaAdmission} from "./public-media-admission";
import type {FeedItem} from "./feed-types";
import type {PublicLiveStream} from "./nostr-live";
/** Independent public sources may authorize media; invalid signing config authorizes none. */
export async function publicMediaSourceAdmission(request:Request,key:string,snapshot:()=>Promise<FeedItem[]>,live:()=>Promise<{available:boolean;streams:PublicLiveStream[]}>){
 mediaAdmission(key,[]); // Validate configuration before invoking either source.
 let unavailable=false;
 try {const sign=mediaAdmission(key,await snapshot())(request);if(sign)return sign;}catch{unavailable=true;}
 try {
  const result=await live();
  const items:FeedItem[]=result.streams.map(stream=>({id:stream.id,source:"nostr",kind:"social",author:stream.author,body:"",ts:stream.starts,permalink:"",tags:[],provenance:"nostr-live",
   media:[{kind:"video",url:stream.url,...(stream.thumbnail?{thumbnail:stream.thumbnail}:{})}]}));
  const sign=mediaAdmission(key,items)(request);if(sign)return sign;
  if(!result.available)unavailable=true;
 }catch{unavailable=true;}
 if(unavailable)throw Error("Public media sources unavailable");
 return null;
}
