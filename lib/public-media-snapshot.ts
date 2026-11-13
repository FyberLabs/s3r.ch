import {openSync,readSync,closeSync} from "node:fs";
import {join} from "node:path";
import {fromGunNode,type FeedItem} from "./feed-types";
/** Read the same atomic public snapshot served to anonymous feed readers. */
export function publicMediaSnapshot(root=process.cwd()):FeedItem[] {
  const fd=openSync(join(root,"public","feed-cache","snapshot.json"),"r");
  try {
    const bytes=Buffer.alloc(8*1024*1024+1);let used=0;
    while(used<bytes.length){const count=readSync(fd,bytes,used,bytes.length-used,null);if(!count)break;used+=count;}
    if(used===bytes.length)throw Error("Snapshot too large");
    const snapshot=JSON.parse(bytes.subarray(0,used).toString("utf8"));
    if(!Array.isArray(snapshot?.items) || snapshot.items.length>5000)throw Error("Invalid public snapshot");
    return snapshot.items.map(fromGunNode).filter((item:FeedItem|null):item is FeedItem=>item!==null);
  } finally {closeSync(fd);}
}

import {fetchPublic} from "./public-fetch";
import {readMediaBytes} from "./public-media-proxy";
import {publicMediaBudget} from "./public-media-admission";
export function peerSnapshotUrl(health:string):string {
  const url=new URL(health);
  if(url.protocol!=="https:" || url.username || url.password || url.search || url.hash ||
      !["/api/health","/_peer/api/health"].includes(url.pathname))throw Error("Invalid peer endpoint");
  url.pathname="/feed-cache/snapshot.json";return url.href;
}
export function createPublicSnapshotLoader(read=fetchPublic,clock=Date.now) {
  let cached:FeedItem[]|null=null,until=0,lastUrl="",pending:Promise<FeedItem[]>|null=null;
  return async (health=process.env.S3RCH_GUN_HEALTH_URL):Promise<FeedItem[]>=>{
    if(!health)return publicMediaSnapshot();
    const url=peerSnapshotUrl(health);
    if(lastUrl!==url){cached=null;until=0;pending=null;lastUrl=url;}
    if(cached && clock()<until)return cached;
    if(pending)return pending;
    const operation=(async()=>{
      const response=await read(url,{accept:"application/json"});
      if(!response.ok || !(response.headers.get("content-type")??"").toLowerCase().startsWith("application/json")){
        await response.body?.cancel();throw Error("Peer snapshot unavailable");
      }
      const bytes=await readMediaBytes(response,8*1024*1024,15000,publicMediaBudget.bytes);
      const value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
      if(!Array.isArray(value?.items)||value.items.length>5000)throw Error("Invalid peer snapshot");
      const items=value.items.map(fromGunNode).filter((item:FeedItem|null):item is FeedItem=>item!==null);
      if(lastUrl===url){cached=items;until=clock()+5000;}return items;
    })();
    pending=operation;
    try{return await operation;}finally{if(pending===operation)pending=null;}
  };
}
export const authoritativePublicMediaSnapshot=createPublicSnapshotLoader();
