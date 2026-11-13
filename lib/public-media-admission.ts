import {createHmac,timingSafeEqual} from "node:crypto";
import {parseFeedMedia,publicMediaUrl} from "./feed-media";
import type {FeedItem} from "./feed-types";
export function mediaIsAdmitted(items:readonly FeedItem[],url:string,kind:string):boolean {
  return items.some(item=>parseFeedMedia(item.media).some(media=>
    (media.url===url && media.kind===kind) || (media.thumbnail===url && kind==="image")));
}
const mac=(key:string,value:string)=>createHmac("sha256",key).update("s3rch-public-media-v1\0"+value).digest("hex");
export function mediaAdmission(key:string,items:readonly FeedItem[],now=Date.now()) {
  if(key.length<32)throw Error("Media admission unavailable");
  return (request:Request):((url:string,kind:string,depth:number)=>string)|null=>{
    const query=new URL(request.url).searchParams;
    const target=publicMediaUrl(query.get("url")),kind=query.get("kind")??"",depth=query.get("depth")??"0";
    if(!target || !/^[0-3]$/.test(depth))return null;
    let root=target,rootKind=kind,expires=now+3600_000;
    if(depth!=="0") {
      root=query.get("root")??"";rootKind=query.get("rootKind")??"";expires=Number(query.get("expires"));
      const signature=query.get("signature")??"";
      if(!/^[a-f0-9]{64}$/.test(signature) || !Number.isSafeInteger(expires) || expires<=now || expires>now+3600_000)return null;
      const expected=mac(key,JSON.stringify([target,kind,depth,root,rootKind,expires]));
      if(!timingSafeEqual(Buffer.from(signature,"hex"),Buffer.from(expected,"hex")))return null;
    }
    if(!mediaIsAdmitted(items,root,rootKind))return null;
    return (url,childKind,childDepth)=>{
      const data=[url,childKind,String(childDepth),root,rootKind,expires];
      return `/api/feed/media?${new URLSearchParams({url,kind:childKind,depth:String(childDepth),root,rootKind,expires:String(expires),signature:mac(key,JSON.stringify(data))})}`;
    };
  };
}
/** Per-replica aggregate budget across callers, not a spoofable client-IP bucket. */
export function createMediaBudget(requestLimit=120,byteLimit=256*1024*1024,clock=Date.now) {
  let until=0,requests=0,bytes=0;
  const refresh=()=>{const now=clock();if(now>=until){until=now+60_000;requests=0;bytes=0;}};
  return {request(){refresh();if(requests>=requestLimit)return false;requests++;return true;},
    bytes(count:number){refresh();if(count>byteLimit-bytes)return false;bytes+=count;return true;}};
}

export const publicMediaBudget = createMediaBudget();
