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
