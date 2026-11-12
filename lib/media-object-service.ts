import { createHash } from "node:crypto";
import { isCanonicalObjectId } from "./identity/object-id";
import { OBJECT_BYTES_MAX, type ObjectStore } from "./object-store";
import { RecordConflict, type RecordStore } from "./record-store";
import { matchesBrowserOrigin } from "./request-origin";

const INDEX = "object-index-v1", COUNT_MAX = 128, TOTAL_MAX = 256 * 1024 * 1024;
type Entry = { object: string; digest: string; length: number };
const objectOK = (id: unknown): id is string => typeof id === "string" && id.startsWith("media_") && isCanonicalObjectId(id);
const digestOK = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{64}$/.test(id);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie, Authorization, Origin" };
function index(bytes: Uint8Array): Entry[] {
  if (bytes.length > 128 * 1024) throw Error("Invalid media index");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || Object.keys(value).sort().join() !== "entries,version" || value.version !== 1 ||
      !Array.isArray(value.entries) || value.entries.length > COUNT_MAX) throw Error("Invalid media index");
  const seen = new Set<string>(); let total = 0;
  for (const row of value.entries) {
    if (!row || Object.keys(row).sort().join() !== "digest,length,object" || !objectOK(row.object) || !digestOK(row.digest) ||
        !Number.isSafeInteger(row.length) || row.length < 33 || row.length > OBJECT_BYTES_MAX || seen.has(row.object)) throw Error("Invalid media index");
    seen.add(row.object); total += row.length;
  }
  if (total > TOTAL_MAX) throw Error("Invalid media index");
  return value.entries;
}
/** Opaque ciphertext only. authorize must authenticate the current SEA session
 * and freshly read complete authority on EVERY call. No client grants or paths.
 * The bounded primary index reserves quota before storing bytes; failed uploads
 * retain their reservation for an identical retry, never silently free capacity.
 */
export function createMediaObjectService(input: {
  origin: string; records: RecordStore; objects: ObjectStore;
  authorize(request: Request, object: string, action: "read" | "write", signal: AbortSignal): Promise<boolean>;
}) {
  const origin = new URL(input.origin);
  if (origin.origin !== input.origin || origin.protocol !== "https:") throw Error("Canonical HTTPS origin required");
  let active = 0;
  return async (request: Request, object: string): Promise<Response> => {
    const reply = (status: number) => new Response(null, { status, headers });
    if (!["GET", "PUT"].includes(request.method)) return reply(405);
    const originHeaders = new Headers(request.headers);
    if (request.method === "GET" && !originHeaders.has("origin") && originHeaders.get("sec-fetch-site") === "same-origin")
      originHeaders.set("origin", origin.origin);
    const originRequest = request.method === "GET" ? new Request(request, { headers: originHeaders }) : request;
    if (!matchesBrowserOrigin(originRequest, origin)) return reply(403);
    if (!objectOK(object)) return reply(400);
    if (active >= 2) return reply(429);
    active++;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]);
    const allowed = async () => {
      signal.throwIfAborted();
      const result = await input.authorize(request, object, request.method === "GET" ? "read" : "write", signal);
      signal.throwIfAborted(); return result;
    };
    try {
      if (!await allowed()) return reply(403);
      if (request.method === "GET") {
        const stored = await input.records.get("media", INDEX, signal);
        const entry = stored && index(stored.bytes).find(row => row.object === object);
        if (!entry) return reply(404);
        const bytes = await input.objects.get(entry.digest, signal);
        if (!bytes) return reply(404);
        if (bytes.length !== entry.length || hash(bytes) !== entry.digest) throw Error("Invalid ciphertext");
        if (!await allowed()) return reply(403);
        return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes.length), ETag: `"${entry.digest}"`, "Content-Disposition": "attachment" } });
      }
      const digest = request.headers.get("x-media-sha256"), length = request.headers.get("content-length");
      if (!digestOK(digest) || !length || !/^[1-9][0-9]{0,7}$/.test(length) || Number(length) < 33 || Number(length) > OBJECT_BYTES_MAX) return reply(413);
      if (request.headers.get("content-type") !== "application/octet-stream" ||
          ![null, "identity"].includes(request.headers.get("content-encoding"))) return reply(415);
      if (!request.body) return reply(400);
      const reader = request.body.getReader(), bytes = new Uint8Array(Number(length)); let offset = 0;
      const abort = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          signal.throwIfAborted(); const chunk = await reader.read(); signal.throwIfAborted();
          if (chunk.done) break;
          if (offset + chunk.value.length > bytes.length) return reply(413);
          bytes.set(chunk.value, offset); offset += chunk.value.length;
        }
      } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (offset !== bytes.length || hash(bytes) !== digest || bytes[0] !== 0x73 || bytes[1] !== 0x33 || bytes[2] !== 0x6d || bytes[3] !== 1) return reply(400);
      let reserved = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const stored = await input.records.get("media", INDEX, signal), entries = stored ? index(stored.bytes) : [];
        const existing = entries.find(row => row.object === object);
        if (existing) {
          if (existing.digest !== digest || existing.length !== bytes.length) return reply(409);
          reserved = true; break;
        }
        if (entries.length >= COUNT_MAX || entries.reduce((sum, row) => sum + row.length, bytes.length) > TOTAL_MAX) return reply(507);
        if (!await allowed()) return reply(403);
        entries.push({ object, digest, length: bytes.length });
        try {
          await input.records.put("media", INDEX, new TextEncoder().encode(JSON.stringify({ version: 1, entries })), stored?.revision ?? null, signal);
          reserved = true; break;
        } catch (error) { if (!(error instanceof RecordConflict)) throw error; }
      }
      if (!reserved) return reply(409);
      if (!await allowed()) return reply(403);
      await input.objects.put(digest, bytes, signal);
      if (!await allowed()) return reply(403);
      return new Response(null, { status: 201, headers: { ...headers, ETag: `"${digest}"` } });
    } catch { return reply(503); }
    finally { active--; }
  };
}
