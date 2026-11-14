import {publicConversations} from "@/lib/public-conversation";
import {conversationMediaTickets} from "@/lib/conversation-media";
import {isFeedSource} from "@/lib/feed-types";
import {cachedConversation} from "@/lib/feed-conversation";
import {authoritativePublicMediaSnapshot} from "@/lib/public-media-snapshot";
import {createMediaQueue} from "@/lib/public-media-proxy";
export const runtime="nodejs";
export const dynamic="force-dynamic";
// FIFO admission bounds concurrent work without a shared minute-long lockout.
const acquire=createMediaQueue(4,32,5000);
export async function GET(request:Request){
 const query=new URL(request.url).searchParams,source=query.get("source"),id=query.get("id");
 if(!isFeedSource(source) || !id || id.length>2048)return new Response("Invalid conversation",{status:400});
 const release=await acquire(request.signal);
 if(!release)return new Response("Busy",{status:429,headers:{"retry-after":"5"}});
 try {
  const rows=await authoritativePublicMediaSnapshot(),key=process.env.IDENTITY_SESSION_SECRET??"";
  const result=key.length>=32?await publicConversations(rows,source,id):cachedConversation(rows,source,id);
  if(!result)return new Response("Post unavailable",{status:404});
  const anchor=rows.find(row=>row.source===source&&row.id===id)!;
  const body=JSON.stringify({...result,...(key.length>=32?{mediaTickets:conversationMediaTickets(key,anchor,result)}:{})});
  if(new TextEncoder().encode(body).length>512*1024)return new Response("Conversation too large",{status:413});
  return new Response(body,{headers:{"content-type":"application/json","cache-control":"no-store"}});
 }catch{return new Response("Conversation unavailable",{status:503});}
 finally{release();}
}
