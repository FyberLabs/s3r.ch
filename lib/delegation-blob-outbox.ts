import type { ContainerClient } from "@azure/storage-blob";
import type { Readable } from "node:stream";
import type { CancellationOutboxStore } from "./delegation-outbox";

export const CANCELLATION_BLOB_MAX_BYTES = 1_048_576;
type Container = Pick<ContainerClient, "getBlockBlobClient">;
function serviceError(error: unknown, status: number, code: string): boolean {
  const e = error as { statusCode?: number; code?: string } | null;
  return e?.statusCode === status && e.code === code;
}
/** Server-only storage adapter. Supply a trusted primary-endpoint container
 * client without secondary-read failover. Namespace is an authenticated scope
 * digest chosen by the coordinator, never an arbitrary browser-supplied path.
 * No container creation, deletion, or grant publication happens here.
 */
export function createBlobCancellationOutboxStore(container: Container, namespace: string): CancellationOutboxStore {
  if (!/^[0-9a-f]{64}$/.test(namespace)) throw Error("invalid outbox namespace");
  const blob = (id: string) => {
    if (!/^[0-9a-f]{32}$/.test(id)) throw Error("invalid operation ID");
    return container.getBlockBlobClient(`s3rch-delegation-outbox/v1/${namespace}/${id}.json`);
  };
  return Object.freeze({
    async create(id: string, text: string) {
      const client = blob(id);
      if (typeof text !== "string") throw Error("invalid outbox document");
      const body = Buffer.from(text, "utf8");
      if (!body.length || body.length > CANCELLATION_BLOB_MAX_BYTES) throw Error("outbox capacity");
      try {
        const result = await client.upload(body, body.length, {
          conditions: { ifNoneMatch: "*" }, abortSignal: AbortSignal.timeout(15_000),
          blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8", blobCacheControl: "no-store" },
        });
        if (!result.etag) throw Error("missing outbox write ETag");
      } catch (error) {
        // Only precise conditional-create conflicts mean an existing slot.
        // Authorization, leases, missing containers and transport errors propagate.
        if (!serviceError(error, 412, "ConditionNotMet") && !serviceError(error, 409, "BlobAlreadyExists")) throw error;
      }
      // The higher-level outbox compares durable read-back with its intent.
    },
    async read(id: string) {
      const client = blob(id);
      try {
        // Request at most the cap plus one sentinel byte, even for a corrupt blob.
        const response = await client.download(0, CANCELLATION_BLOB_MAX_BYTES + 1, { abortSignal: AbortSignal.timeout(15_000) });
        const stream = response.readableStreamBody as Readable | undefined;
        if (!stream) throw Error("missing outbox body");
        try {
          if (!response.etag || response.contentLength === undefined || response.contentLength > CANCELLATION_BLOB_MAX_BYTES) throw Error("invalid outbox read");
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of stream) {
            const part = Buffer.from(chunk); size += part.length;
            if (size > CANCELLATION_BLOB_MAX_BYTES) throw Error("outbox capacity");
            chunks.push(part);
          }
          if (!size || size !== response.contentLength) throw Error("incomplete outbox read");
          return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
        } finally { stream.destroy(); }
      } catch (error) {
        if (serviceError(error, 404, "BlobNotFound")) return null;
        throw error;
      }
    },
  });
}
