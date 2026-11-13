import {publicLiveDirectory} from "@/lib/nostr-live";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(){
 const result=await publicLiveDirectory();
 return Response.json(result,{headers:{"cache-control":"no-store"}});
}
