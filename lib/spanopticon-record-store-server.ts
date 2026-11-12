import { readCacheAccess } from "./spanopticon-cache-access-server";
import { RECORD_BYTES_MAX, RecordConflict, type RecordNamespace, type RecordStore } from "./record-store";

function recordPath(namespace: RecordNamespace, name: string) {
  if (!["cache", "recovery", "fixtures"].includes(namespace) || !/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new Error("Invalid record name");
  return namespace + "/" + name;
}
function revision(value: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Invalid record revision");
  return value;
}
function returnedRevision(response: Response) {
  const value = response.headers.get("etag");
  if (!value || !/^"[0-9a-f]{64}"$/.test(value)) throw new Error();
  return value.slice(1, -1);
}

/** Construct only in server code from deployment-owned settings. */
export function createSpanopticonRecordStore(config: Readonly<{ origin: string; tenant: string; apiKey: string }>, fetcher: typeof fetch = fetch): RecordStore {
  const origin = new URL(config.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || origin.port)
    throw new Error("Invalid storage origin");
  const tenant = config.tenant, apiKey = config.apiKey;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant) || tenant === "00000000-0000-0000-0000-000000000000" ||
      typeof apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(apiKey)) throw new Error("Invalid storage configuration");
  const base = origin.origin + "/api/v1/storage/records/";
  async function request<T>(method: string, path: string, bytes: Uint8Array<ArrayBuffer> | undefined, conditions: Record<string, string>, signal: AbortSignal | undefined, consume: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
    const timeout = AbortSignal.timeout(120_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response | undefined;
    try {
      combined.throwIfAborted();
      response = await fetcher(base + path, { method, redirect: "error", cache: "no-store", credentials: "omit", signal: combined,
        headers: { "X-Api-Key": apiKey, "X-Tenant-ID": tenant, "Accept-Encoding": "identity", ...conditions,
          ...(bytes ? { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) } : {}) }, body: bytes });
      combined.throwIfAborted();
      if (method !== "GET" && response.status === 412) throw new RecordConflict();
      const result = await consume(response, combined);
      combined.throwIfAborted();
      return result;
    } catch (error) {
      if (error instanceof RecordConflict) throw error;
      throw new Error("Tenant record storage unavailable");
    } finally {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
  return Object.freeze({
    async get(namespace: RecordNamespace, name: string, signal?: AbortSignal) {
      const path = recordPath(namespace, name);
      if (namespace === "cache") {
        const direct = await request("GET", path + "/access", undefined, {}, signal,
          (response, deadline) => readCacheAccess(response, tenant, name, fetcher, deadline));
        if (direct !== undefined) return direct;
      }
      return request("GET", path, undefined, {}, signal, async response => {
        if (response.status === 404) return null;
        if (response.status !== 200 || !response.body || ![null, "identity"].includes(response.headers.get("content-encoding"))) throw new Error();
        const tag = returnedRevision(response), length = response.headers.get("content-length");
        if (length !== null && (!/^[1-9][0-9]{0,8}$/.test(length) || Number(length) > RECORD_BYTES_MAX)) throw new Error();
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > RECORD_BYTES_MAX || (length !== null && size > Number(length))) throw new Error();
            chunks.push(new Uint8Array(part.value));
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (!size || (length !== null && size !== Number(length))) throw new Error();
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return { bytes, revision: tag };
      });
    },
    async put(namespace: RecordNamespace, name: string, input: Uint8Array, expected: string | null, signal?: AbortSignal) {
      const path = recordPath(namespace, name);
      if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > RECORD_BYTES_MAX) throw new Error("Invalid record size");
      const conditions: Record<string, string> = expected === null ? { "If-None-Match": "*" } : { "If-Match": `"${revision(expected)}"` };
      return request("PUT", path, new Uint8Array(input), conditions, signal, async response => {
        if (response.status !== (expected === null ? 201 : 204)) throw new Error();
        return returnedRevision(response);
      });
    },
    async delete(namespace: RecordNamespace, name: string, expected: string, signal?: AbortSignal) {
      const path = recordPath(namespace, name);
      await request("DELETE", path, undefined, { "If-Match": `"${revision(expected)}"` }, signal, async response => {
        if (response.status !== 204) throw new Error();
      });
    },
  });
}
