import { servePublicMedia } from "@/lib/public-media-proxy";
import { mediaAdmission, publicMediaBudget } from "@/lib/public-media-admission";
import { authoritativePublicMediaSnapshot } from "@/lib/public-media-snapshot";
import {publicLiveDirectory} from "@/lib/nostr-live";
import type {FeedItem} from "@/lib/feed-types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if(!publicMediaBudget.request())return new Response("Media quota exhausted",{status:429,headers:{"retry-after":"60"}});
  let sign;
  try { sign=mediaAdmission(process.env.IDENTITY_SESSION_SECRET??"",await authoritativePublicMediaSnapshot())(request); }
  catch { return new Response("Media unavailable",{status:503}); }
  if(!sign){
    try {
      const {streams}=await publicLiveDirectory();
      const items:FeedItem[]=streams.map(stream=>({id:stream.id,source:"nostr",kind:"social",author:stream.author,body:"",ts:stream.starts,permalink:"",tags:[],provenance:"nostr-live",
        media:[{kind:"video",url:stream.url,...(stream.thumbnail?{thumbnail:stream.thumbnail}:{})}]}));
      sign=mediaAdmission(process.env.IDENTITY_SESSION_SECRET??"",items)(request);
    }catch{return new Response("Media unavailable",{status:503});}
  }
  if(!sign)return new Response("Media not admitted",{status:403});
  return servePublicMedia(request,undefined,sign,true);
}
