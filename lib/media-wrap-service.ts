import { isSeaPubkey } from "./identity/forum-check";
import { isCanonicalObjectId } from "./identity/object-id";
import { readBoundedIdentityJson } from "./identity/bounded-json";
import { matchesBrowserOrigin } from "./request-origin";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie, Origin" };
export type MediaReaderConfig = Readonly<{ origin: string; tenant: string;
  readers: readonly Readonly<{ principal: string; apiKey: string }>[] }>;
export function parseMediaReaderConfig(raw: string): MediaReaderConfig {
  if (typeof raw !== "string" || raw.length > 327680) throw Error("Invalid private media configuration");
  const value = JSON.parse(raw);
  if (!value || Object.keys(value).sort().join() !== "origin,readers,tenant" || typeof value.origin !== "string" ||
      typeof value.tenant !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.tenant) ||
      value.tenant === "00000000-0000-0000-0000-000000000000" || !Array.isArray(value.readers) || !value.readers.length || value.readers.length > 64)
    throw Error("Invalid private media configuration");
  const origin = new URL(value.origin);
  if (origin.protocol !== "https:" || origin.origin !== value.origin || origin.username || origin.password || origin.port)
    throw Error("Invalid private media configuration");
  const principals = new Set<string>(), keys = new Set<string>();
  for (const reader of value.readers) {
    if (!reader || Object.keys(reader).sort().join() !== "apiKey,principal" || !isSeaPubkey(reader.principal) ||
        typeof reader.apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(reader.apiKey) ||
        principals.has(reader.principal) || keys.has(reader.apiKey)) throw Error("Invalid private media configuration");
    principals.add(reader.principal); keys.add(reader.apiKey);
  }
  return structuredClone(value);
}

/** Each credential is provisioned for one fixed ACL subject/reader binding.
 * A shared service credential must never carry a client-selected reader. */
export function createMediaWrapService(config: MediaReaderConfig, siteOrigin: string,
  resolveReader: (request: Request, signal: AbortSignal) => Promise<string | null>,
  fetcher: typeof fetch = fetch, clock = () => Date.now() / 1000) {
  const held = parseMediaReaderConfig(JSON.stringify(config)), origin = new URL(siteOrigin);
  if (origin.protocol !== "https:" || origin.origin !== siteOrigin) throw Error("Invalid site origin");
  const readers = new Map(held.readers.map(row => [row.principal, row.apiKey]));
  const active = new Set<string>(); let preflights = 0, transports = 0;
  return async (request: Request) => {
    const reply = (status: number) => new Response(null, { status, headers });
    if (request.method !== "POST") return reply(405);
    if (!matchesBrowserOrigin(request, origin)) return reply(403);
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json" ||
        ![null, "identity"].includes(request.headers.get("content-encoding"))) return reply(415);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(4000)]);
    let reader: string | null = null, occupied = false, transport = false;
    try {
      if (preflights >= 2) return reply(429);
      preflights++;
      try { reader = await resolveReader(request, signal); signal.throwIfAborted(); }
      finally { preflights--; }
      if (!reader || !readers.has(reader)) return reply(403);
      if (active.has(reader)) return reply(429);
      active.add(reader); occupied = true;
      const body = await readBoundedIdentityJson(new Response(request.body), 2048,
        AbortSignal.any([signal, AbortSignal.timeout(1000)]));
      if (!body || typeof body !== "object" || Object.keys(body).join() !== "object") return reply(400);
      const object = (body as { object: unknown }).object;
      if (typeof object !== "string" || !object.startsWith("media_") || !isCanonicalObjectId(object)) return reply(400);
      if (transports >= 2) return reply(429);
      transports++; transport = true;
      const response = await fetcher(held.origin + "/api/v1/acl/sociacl/media/read-wrap", {
        method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal,
        headers: { "X-Api-Key": readers.get(reader)!, "X-Tenant-ID": held.tenant,
          "Content-Type": "application/json", "Accept-Encoding": "identity" }, body: JSON.stringify({ object }) });
      if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0] !== "application/json" ||
          ![null, "identity"].includes(response.headers.get("content-encoding"))) {
        await response.body?.cancel().catch(() => {}); return reply(403);
      }
      const result = await readBoundedIdentityJson(response, 100000, signal) as Record<string, unknown>;
      const context = result?.context as Record<string, unknown> | undefined;
      if (!result || Object.keys(result).sort().join() !== "context,expiresAt,readerEpub,wrapBase64" ||
          !context || typeof context !== "object" || Object.keys(context).sort().join() !== "epoch,object,revisionId" ||
          context.object !== object || !Number.isSafeInteger(context.epoch) || (context.epoch as number) < 1 ||
          typeof context.revisionId !== "string" || !/^[a-f0-9]{64}$/.test(context.revisionId) ||
          typeof result.expiresAt !== "number" || !Number.isFinite(result.expiresAt) || result.expiresAt <= clock() ||
          result.expiresAt > clock() + 3 || typeof result.readerEpub !== "string" || !isSeaPubkey(result.readerEpub) || typeof result.wrapBase64 !== "string" ||
          !result.wrapBase64.length || result.wrapBase64.length > 87384 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.wrapBase64)) return reply(403);
      // Rotation or session expiry during provider delivery must refuse before
      // returning even encrypted reader material to the browser.
      if (await resolveReader(request, signal) !== reader) return reply(403);
      signal.throwIfAborted();
      if (clock() >= result.expiresAt) return reply(403);
      return Response.json(result, { headers });
    } catch { return reply(503); }
    finally {
      if (occupied && reader) active.delete(reader);
      if (transport) transports--;
      if (!request.bodyUsed) void request.body?.cancel().catch(() => {});
    }
  };
}

