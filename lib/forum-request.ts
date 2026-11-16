/** Read/compute/compare-and-swap; no Azure call blocks the request event loop. */
import { BlobForumStore } from "./forum-blob";
import { getForum, openForum, type Forum } from "./forum";
import { forumAsyncClient, type AsyncForumClient } from "./forum-blob-async";
import { type IdentityBlobConditions } from "../identity-blob.cjs";

export async function blobForumRequest(client: AsyncForumClient, handler: (forum: Forum) => Response): Promise<Response> {
  try {
    let current = await client.download();
    let pending: {text:string;conditions:IdentityBlobConditions} | null = null;
    const store = new BlobForumStore({assertReachable() {}, download:()=>current,
      upload(_name,text,conditions) {
        if(!current.found || conditions.ifMatch!==current.etag) throw new Error("Invalid request snapshot");
        pending={text,conditions}; current={...current,text}; return {etag:current.etag};
      },
    });
    if (!store.load().ok) throw new Error("Forum document unavailable");
    const response=handler(openForum(store));
    // The synchronous model may reject a write. Never publish an intermediate
    // result from a refused request and never acknowledge before durable commit.
    const write=pending as {text:string;conditions:IdentityBlobConditions} | null;
    if (response.ok && write) await client.upload(write.text,write.conditions);
    return response;
  } catch(error) {
    const status=(error as {statusCode?:number}).statusCode;
    const conflict=status===409 || status===412 || (error as {code?:string}).code==='blob-conflict';
    return Response.json({denied:true,reason:conflict?'store-conflict':'store-unreadable'},
      {status:conflict?409:503,headers:{'Cache-Control':'private, no-store'}});
  }
}
export async function forumRequest(handler: (forum: Forum) => Response): Promise<Response> {
  const mode=process.env.S3RCH_FORUM_STORAGE || 'file';
  if(mode==='file') return handler(getForum());
  if(mode!=='blob') return Response.json({denied:true,reason:'store-unreadable'},{status:503});
  try { return await blobForumRequest(await forumAsyncClient(),handler); }
  catch { return Response.json({denied:true,reason:'store-unreadable'},{status:503}); }
}
