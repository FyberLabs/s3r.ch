import { createHash } from "node:crypto";
import { OBJECT_BYTES_MAX, type ObjectStore } from "./object-store";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function address(value: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Invalid object address");
  return value;
}

/** Server-only tenant service credential. Construct from deployment settings,
 * never browser-selected URLs or tokens. This adapter confers no end-user grant. */
export function createSpanopticonObjectStore(config: Readonly<{ origin: string; tenant: string; apiKey: string }>, fetcher: typeof fetch = fetch): ObjectStore {
  const origin = new URL(config.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || origin.port)
    throw new Error("Invalid storage origin");
  const tenant = config.tenant, apiKey = config.apiKey;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant) || tenant === "00000000-0000-0000-0000-000000000000" ||
      typeof apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(apiKey)) throw new Error("Invalid storage configuration");
  const base = origin.origin + "/api/v1/storage/objects/";
  async function request<T>(method: string, id: string, bytes: Uint8Array<ArrayBuffer> | undefined, signal: AbortSignal | undefined, consume: (response: Response) => Promise<T>): Promise<T> {
    const timeout = AbortSignal.timeout(120_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response | undefined;
    try {
      combined.throwIfAborted();
      response = await fetcher(base + address(id), { method, redirect: "error", cache: "no-store", credentials: "omit", signal: combined,
        headers: { "X-Api-Key": apiKey, "X-Tenant-ID": tenant, "Accept-Encoding": "identity", ...(bytes ? { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) } : {}) },
        body: bytes });
      combined.throwIfAborted();
      const result = await consume(response);
      combined.throwIfAborted();
      return result;
    } catch {
      // Provider bodies, request headers and exception causes may contain secrets.
      throw new Error("Tenant object storage unavailable");
    } finally {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
  return Object.freeze({
    async put(id: string, input: Uint8Array, signal?: AbortSignal) {
      address(id);
      if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > OBJECT_BYTES_MAX) throw new Error("Invalid object size");
      const bytes = new Uint8Array(input);
      if (hash(bytes) !== id) throw new Error("Object checksum differs");
      await request("PUT", id, bytes, signal, async response => {
        if (![201, 204].includes(response.status) || response.headers.get("etag") !== `"${id}"`) throw new Error();
      });
    },
    async get(id: string, signal?: AbortSignal) {
      address(id);
      return request("GET", id, undefined, signal, async response => {
        if (response.status === 404) return null;
        if (response.status !== 200 || response.headers.get("etag") !== `"${id}"` || !response.body ||
            ![null, "identity"].includes(response.headers.get("content-encoding"))) throw new Error();
        const length = response.headers.get("content-length");
        if (length !== null && (!/^[1-9][0-9]{0,8}$/.test(length) || Number(length) > OBJECT_BYTES_MAX)) throw new Error();
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > OBJECT_BYTES_MAX || (length !== null && size > Number(length))) throw new Error();
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
        if (hash(bytes) !== id) throw new Error();
        return bytes;
      });
    },
    async delete(id: string, signal?: AbortSignal) {
      address(id);
      await request("DELETE", id, undefined, signal, async response => { if (response.status !== 204) throw new Error(); });
    },
  });
}
