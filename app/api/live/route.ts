import {publicLiveDirectory} from "@/lib/nostr-live";
import {publicBlueskyLiveDirectory} from "@/lib/bluesky-live";
import {publicActivityPubLiveDirectory} from "@/lib/activitypub-live";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(){
 const sources=await Promise.all([publicLiveDirectory(),publicBlueskyLiveDirectory(),publicActivityPubLiveDirectory()]);
 const result={available:sources.some(source=>source.available),streams:sources.flatMap(source=>source.streams).sort((a,b)=>b.starts-a.starts).slice(0,100)};
 return Response.json(result,{headers:{"cache-control":"no-store"}});
}
