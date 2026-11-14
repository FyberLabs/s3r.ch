import {createHash,createHmac,timingSafeEqual} from "node:crypto";
import {mediaAdmission} from "./public-media-admission";
import {parseFeedMedia,publicMediaUrl} from "./feed-media";
import type {FeedItem} from "./feed-types";
import type {FeedConversation} from "./feed-conversation";
export const CONVERSATION_MEDIA_MS=3600_000;
const digest=(text:string)=>createHash("sha256").update(text).digest("hex");
const anchorId=(item:FeedItem)=>digest(`${item.source}\0${item.id}`);
const rootId=(url:string,kind:string)=>digest(`${kind}\0${url}`);
const mac=(key:string,body:string)=>createHmac("sha256",key).update("s3rch-conversation-media-v1\0"+body).digest("hex");
/** Short public-media tickets bind each fetched root to a currently public anchor. */
export function conversationMediaTickets(key:string,anchor:FeedItem,conversation:FeedConversation,now=Date.now()){
 if(key.length<32)throw Error("Media admission unavailable");
 const tickets:Record<string,string>={};
 const add=(url:string,kind:string)=>{const body=`${anchorId(anchor)}.${rootId(url,kind)}.${now+CONVERSATION_MEDIA_MS}`;tickets[`${kind}\0${url}`]=`${body}.${mac(key,body)}`;};
 for(const item of [...conversation.items,...conversation.replies])for(const media of parseFeedMedia(item.media)){
  if(["image","audio","video"].includes(media.kind))add(media.url,media.kind);
  if(media.thumbnail)add(media.thumbnail,"image");
 }
 return tickets;
}
export function conversationMediaAdmission(request:Request,key:string,rows:readonly FeedItem[],now=Date.now()){
 const query=new URL(request.url).searchParams,token=query.get("context")??"";
 if(key.length<32||!/^[a-f0-9]{64}\.[a-f0-9]{64}\.\d{1,16}\.[a-f0-9]{64}$/.test(token))return null;
 const [anchor,root,expiry,signature]=token.split("."),expires=Number(expiry);
 if(!Number.isSafeInteger(expires)||expires<=now||expires>now+CONVERSATION_MEDIA_MS)return null;
 const body=`${anchor}.${root}.${expiry}`;
 if(!timingSafeEqual(Buffer.from(signature,"hex"),Buffer.from(mac(key,body),"hex")))return null;
 const child=(query.get("depth")??"0")!=="0",url=publicMediaUrl(query.get(child?"root":"url")),kind=query.get(child?"rootKind":"kind")??"";
 if(!url||!["image","audio","video"].includes(kind)||rootId(url,kind)!==root)return null;
 const item=rows.find(row=>anchorId(row)===anchor);if(!item)return null;
 const sign=mediaAdmission(key,[{...item,media:[{kind:kind as "image"|"audio"|"video",url}]}],now)(request);
 return sign?(url:string,kind:string,depth:number)=>`${sign(url,kind,depth)}&context=${token}`:null;
}
