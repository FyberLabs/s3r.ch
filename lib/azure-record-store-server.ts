import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { ContainerClient } from "@azure/storage-blob";
import { RECORD_BYTES_MAX, RecordConflict, type RecordNamespace, type RecordStore } from "./record-store";

type Container = Pick<ContainerClient, "getProperties" | "getBlockBlobClient">;
const unavailable = () => new Error("Tenant record storage unavailable");
const code = (error: unknown, status: number, name: string) => {
  const value = error as {statusCode?: number; code?: string} | null;
  return value?.statusCode === status && value.code === name;
};
function tag(value: string | undefined): string {
  if (!value || !/^"[A-Za-z0-9._:-]{1,128}"$/.test(value)) throw unavailable();
  return value;
}
const revision = (etag: string) => createHash("sha256").update(etag).digest("hex");
function expectedRevision(value: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Invalid record revision");
  return value;
}

/** Optional self-hosted adapter. The caller supplies a trusted primary-endpoint
 * container with deployment-owned credentials; hosted s3r.ch uses Spanopticon. */
export function createAzureRecordStore(container: Container, tenant: string): RecordStore {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant) || tenant === "00000000-0000-0000-0000-000000000000") throw new Error("Invalid storage tenant");
  function blob(namespace: RecordNamespace, name: string) {
    if (!["cache","recovery","fixtures"].includes(namespace) || !/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new Error("Invalid record name");
    return container.getBlockBlobClient(`s3rch-records/v1/${tenant}/${namespace}/${name}`);
  }
  async function operation<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = AbortSignal.timeout(120_000), combined = signal ? AbortSignal.any([signal,deadline]) : deadline;
    try {
      combined.throwIfAborted();
      const properties = await container.getProperties({abortSignal:combined});
      if (properties.blobPublicAccess !== undefined) throw unavailable();
      const result = await work(combined);
      combined.throwIfAborted();
      return result;
    } catch (error) {
      if (error instanceof RecordConflict) throw error;
      if (code(error,412,"ConditionNotMet") || code(error,409,"BlobAlreadyExists")) throw new RecordConflict();
      throw unavailable();
    }
  }
  async function current(client: ReturnType<Container["getBlockBlobClient"]>, expected: string, signal: AbortSignal) {
    let etag: string;
    try { etag = tag((await client.getProperties({abortSignal:signal})).etag); }
    catch (error) { if (code(error,404,"BlobNotFound")) throw new RecordConflict(); throw error; }
    if (revision(etag) !== expected) throw new RecordConflict();
    return etag;
  }
  return Object.freeze({
    async get(namespace: RecordNamespace, name: string, signal?: AbortSignal) {
      const client = blob(namespace,name);
      return operation(signal,async abortSignal => {
        let response;
        try { response = await client.download(0, RECORD_BYTES_MAX+1, {abortSignal}); }
        catch(error) { if(code(error,404,"BlobNotFound")) return null; throw error; }
        const stream = response.readableStreamBody as Readable | undefined;
        if (!stream) throw unavailable();
        try {
          const etag = tag(response.etag), length=response.contentLength;
          if (!Number.isSafeInteger(length) || !length || length>RECORD_BYTES_MAX || response.contentEncoding) throw unavailable();
          const chunks: Buffer[]=[];let size=0;
          for await (const chunk of stream) {
            abortSignal.throwIfAborted();
            const bytes=Buffer.from(chunk);size+=bytes.length;
            if(size>RECORD_BYTES_MAX || size>length) throw unavailable();
            chunks.push(bytes);
          }
          if(size!==length) throw unavailable();
          return {bytes:new Uint8Array(Buffer.concat(chunks)),revision:revision(etag)};
        } finally { stream.destroy(); }
      });
    },
    async put(namespace: RecordNamespace, name: string, input: Uint8Array, expected: string | null, signal?: AbortSignal) {
      const client=blob(namespace,name);
      if (!(input instanceof Uint8Array) || !input.length || input.length>RECORD_BYTES_MAX) throw new Error("Invalid record size");
      if(expected!==null) expectedRevision(expected);
      const bytes=new Uint8Array(input);
      return operation(signal,async abortSignal=>{
        const conditions=expected===null?{ifNoneMatch:"*"}:{ifMatch:await current(client,expected,abortSignal)};
        const response=await client.upload(bytes,bytes.length,{conditions,abortSignal,
          blobHTTPHeaders:{blobContentType:"application/octet-stream",blobCacheControl:"private, no-store"}});
        return revision(tag(response.etag));
      });
    },
    async delete(namespace: RecordNamespace, name: string, expected: string, signal?: AbortSignal) {
      const client=blob(namespace,name);expectedRevision(expected);
      await operation(signal,async abortSignal=>{
        const etag=await current(client,expected,abortSignal);
        try { await client.delete({conditions:{ifMatch:etag},abortSignal}); }
        catch(error) { if(code(error,404,"BlobNotFound")) throw new RecordConflict();throw error; }
      });
    },
  });
}
