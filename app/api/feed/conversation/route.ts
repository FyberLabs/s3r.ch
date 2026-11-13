import {isFeedSource} from "@/lib/feed-types";
import {cachedConversation} from "@/lib/feed-conversation";
import {publicMediaSnapshot} from "@/lib/public-media-snapshot";
import {createMediaBudget} from "@/lib/public-media-admission";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const budget=createMediaBudget(120,0);
export async function GET(request:Request){
 if(!budget.request())return new Response("Busy",{status:429});
 const query=new URL(request.url).searchParams,source=query.get("source"),id=query.get("id");
 if(!isFeedSource(source) || !id || id.length>2048)return new Response("Invalid conversation",{status:400});
 try {
  const result=cachedConversation(publicMediaSnapshot(),source,id);
  if(!result)return new Response("Post unavailable",{status:404});
  const body=JSON.stringify(result);
  if(new TextEncoder().encode(body).length>512*1024)return new Response("Conversation too large",{status:413});
  return new Response(body,{headers:{"content-type":"application/json","cache-control":"no-store"}});
 }catch{return new Response("Conversation unavailable",{status:503});}
}
