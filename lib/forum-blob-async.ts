/** Nonblocking managed-identity Azure I/O for forum requests and health. */
import { type IdentityBlobDownload, type IdentityBlobConditions } from "../identity-blob.cjs";
import { FORUM_BLOB, MAX_FORUM_BYTES } from "./forum-blob";
export type AsyncForumClient = {
  download(): Promise<IdentityBlobDownload>;
  upload(text: string, conditions: IdentityBlobConditions): Promise<void>;
};
let cached: Promise<AsyncForumClient> | undefined;
export function forumAsyncClient(): Promise<AsyncForumClient> {
  return cached ??= createClient();
}
async function createClient(): Promise<AsyncForumClient> {
  const account = process.env.S3RCH_FORUM_BLOB_ACCOUNT || "";
  const container = process.env.S3RCH_FORUM_BLOB_CONTAINER || "";
  if (!/^[a-z0-9]{3,24}$/.test(account) || !/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/.test(container)) throw new Error("Forum Blob bindings required");
  const [{ ManagedIdentityCredential }, { BlobServiceClient }] = await Promise.all([
    import("@azure/identity"), import("@azure/storage-blob"),
  ]);
  const blob = new BlobServiceClient(`https://${account}.blob.core.windows.net`, new ManagedIdentityCredential())
    .getContainerClient(container).getBlockBlobClient(FORUM_BLOB);
  return {
    async download() {
      try {
        const response = await blob.download(0, MAX_FORUM_BYTES + 1, { abortSignal: AbortSignal.timeout(4000) });
        if (!response.etag || !response.readableStreamBody) throw new Error("Invalid Blob response");
        const chunks: Buffer[] = []; let size = 0;
        for await (const part of response.readableStreamBody) {
          const bytes=Buffer.from(part); size+=bytes.length;
          if(size>MAX_FORUM_BYTES) throw new Error("Forum document capacity exceeded");
          chunks.push(bytes);
        }
        return {found:true,text:Buffer.concat(chunks).toString("utf8"),etag:response.etag};
      } catch(error) {
        if ((error as {statusCode?:number}).statusCode===404) return {found:false};
        throw error;
      }
    },
    async upload(text, conditions) {
      if (!conditions.ifMatch || Buffer.byteLength(text)>MAX_FORUM_BYTES) throw new Error("Conditional bounded write required");
      await blob.upload(text,Buffer.byteLength(text),{conditions,abortSignal:AbortSignal.timeout(4000),
        blobHTTPHeaders:{blobContentType:"application/json",blobCacheControl:"no-store"}});
    },
  };
}
