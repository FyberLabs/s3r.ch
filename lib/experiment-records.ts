import type { ExperimentRecordStore } from "./experiment-outbox";

/** Separate keys are required for read-only flag bytes and mutable outbox data.
 * Construct only from server deployment settings, never request parameters. */
export function createExperimentRecords(input: { origin: string; tenant: string; cacheKey: string; outboxKey: string }, transport: typeof fetch = fetch) {
  const origin = new URL(input.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.port || origin.search || origin.hash ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.tenant) || input.tenant === "00000000-0000-0000-0000-000000000000" ||
      input.cacheKey === input.outboxKey || [input.cacheKey, input.outboxKey].some(k => !/^[\x21-\x7e]{16,4096}$/.test(k))) throw Error("Invalid experiment storage binding");
  async function request(method: string, path: string, key: string, body?: string, revision?: string | null, signal?: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, 3000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const response = await transport(`${origin.origin}/api/v1/storage/records/${path}`, {
        method, cache: "no-store", redirect: "error", credentials: "omit", signal: controller.signal,
        headers: { "X-Api-Key": key, "X-Tenant-ID": input.tenant, "Accept-Encoding": "identity",
          ...(body === undefined ? {} : { "Content-Type": "application/octet-stream", "Content-Length": String(Buffer.byteLength(body)) }),
          ...(revision === null ? { "If-None-Match": "*" } : revision === undefined ? {} : { "If-Match": `"${revision}"` }) }, body,
      });
      let bytes = new Uint8Array();
      try {
        if (response.body && response.status === 200) {
          const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
          try {
            while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
              if (size > 65536) throw Error(); parts.push(part.value); }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          bytes = new Uint8Array(size); let offset = 0;
          for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
        }
        return { status: response.status, etag: response.headers.get("etag"), bytes };
      } finally { if (response.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
    } catch { throw Error("Experiment storage unavailable"); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  const path = (name: string) => {
    if (!/^s3rch-outbox-[a-f0-9]{64}$/.test(name)) throw Error("Invalid experiment record");
    return `experiments/${name}`;
  };
  const outbox: ExperimentRecordStore = {
    async read(name) {
      const result = await request("GET", path(name), input.outboxKey);
      if (result.status === 404) return null;
      if (result.status !== 200 || !result.etag || !/^"[a-f0-9]{64}"$/.test(result.etag)) throw Error("Experiment storage unavailable");
      return { value: new TextDecoder("utf-8", { fatal: true }).decode(result.bytes), revision: result.etag.slice(1, -1) };
    },
    async write(name, value, revision) {
      if (Buffer.byteLength(value) > 65536 || revision !== null && !/^[a-f0-9]{64}$/.test(revision)) throw Error("Invalid experiment record");
      const result = await request("PUT", path(name), input.outboxKey, value, revision);
      if (result.status === 412) return false;
      if (result.status !== (revision === null ? 201 : 204)) throw Error("Experiment storage unavailable");
      return true;
    },
  };
  return Object.freeze({ outbox, cache: {
    async get(namespace: "cache", name: string, signal?: AbortSignal) {
      if (namespace !== "cache" || name !== "experiments-v1-s3rch") throw Error("Invalid experiment cache");
      const result = await request("GET", "experiments/s3rch-cache", input.cacheKey, undefined, undefined, signal);
      if (result.status === 404) return null;
      if (result.status !== 200) throw Error("Experiment cache unavailable");
      return { bytes: result.bytes };
    },
  } });
}
