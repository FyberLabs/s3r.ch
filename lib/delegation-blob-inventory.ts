import type { ContainerClient } from "@azure/storage-blob";
import type { Readable } from "node:stream";
import type { InventoryStore } from "./delegation-inventory";

const matches = (error: unknown, statusCode: number, code: string) => {
  const e = error as { statusCode?: number; code?: string } | null;
  return e?.statusCode === statusCode && e.code === code;
};
/** Trusted primary container, same scope rules as the cancellation outbox.
 * Distinct path: the mutable registry never replaces immutable signed records.
 */
export function createBlobInventoryStore(container: Pick<ContainerClient, "getBlockBlobClient">, namespace: string): InventoryStore {
  return createBlobCasStore(container, namespace, "s3rch-delegation-inventory/v1", 131072);
}
/** Separate bounded slot for the authoritative assignment journal. Supply an
 * authenticated primary container and a server-derived Squad namespace. */
export function createBlobAssignmentJournalStore(container: Pick<ContainerClient, "getBlockBlobClient">, namespace: string): InventoryStore {
  return createBlobCasStore(container, namespace, "s3rch-assignment-journal/v1", 2_097_152);
}
/** Dedicated replay slot; never shares assignment state. Provision on a primary
 * container without deletion/rollback while any challenge can remain valid. */
export function createBlobSquadSessionReplayStore(container: Pick<ContainerClient, "getBlockBlobClient">, namespace: string): InventoryStore {
  return createBlobCasStore(container, namespace, "s3rch-squad-session-replay/v1", 400_000);
}
function createBlobCasStore(container: Pick<ContainerClient, "getBlockBlobClient">, namespace: string, prefix: string, CAP: number): InventoryStore {
  if (typeof namespace !== "string" || !/^[0-9a-f]{64}$/.test(namespace)) throw Error("invalid inventory namespace");
  const blob = container.getBlockBlobClient(`${prefix}/${namespace}.json`);
  return Object.freeze({
    async read() {
      try {
        const response = await blob.download(0, CAP + 1, { abortSignal: AbortSignal.timeout(15000) });
        const stream = response.readableStreamBody as Readable | undefined;
        if (!stream) throw Error("missing inventory body");
        try {
          if (!response.etag || response.contentLength === undefined || response.contentLength > CAP) throw Error("invalid inventory response");
          const parts: Buffer[] = []; let size = 0;
          for await (const chunk of stream) {
            const part = Buffer.from(chunk); size += part.length;
            if (size > CAP) throw Error("inventory capacity");
            parts.push(part);
          }
          if (!size || size !== response.contentLength) throw Error("truncated inventory");
          return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts)), etag: response.etag };
        } finally { stream.destroy(); }
      } catch (error) {
        if (matches(error, 404, "BlobNotFound")) return null;
        throw error;
      }
    },
    async compareAndSwap(etag: string | null, text: string) {
      if (etag !== null && (typeof etag !== "string" || !etag || etag === "*")) throw Error("invalid inventory ETag");
      if (typeof text !== "string") throw Error("invalid inventory document");
      const body = Buffer.from(text);
      if (!body.length || body.length > CAP) throw Error("inventory capacity");
      try {
        const result = await blob.upload(body, body.length, { abortSignal: AbortSignal.timeout(15000),
          conditions: etag === null ? { ifNoneMatch: "*" } : { ifMatch: etag },
          blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8", blobCacheControl: "no-store" },
        });
        if (!result.etag) throw Error("missing inventory write ETag");
        return true;
      } catch (error) {
        if (matches(error, 412, "ConditionNotMet") || (etag === null && matches(error, 409, "BlobAlreadyExists"))) return false;
        throw error;
      }
    },
  });
}
