import { isSeaPubkey } from "./identity/forum-check";
import { isCanonicalObjectId } from "./identity/object-id";
import { readBoundedIdentityJson } from "./identity/bounded-json";
import { matchesBrowserOrigin } from "./request-origin";
import { parseMediaReaderConfig, type MediaReaderConfig } from "./media-wrap-service";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie, Origin" };
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === keys.sort().join();
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Fixed subject credentials only. The ACL source verifies every owner signature. */
export function createMediaOwnerService(config: MediaReaderConfig, siteOrigin: string,
  resolvePrincipal: (request: Request, signal: AbortSignal) => Promise<string | null>,
  fetcher: typeof fetch = fetch, clock = () => Date.now() / 1000) {
  const held = parseMediaReaderConfig(JSON.stringify(config)), origin = new URL(siteOrigin);
  if (origin.protocol !== "https:" || origin.origin !== siteOrigin) throw Error("Invalid site origin");
  const credentials = new Map(held.readers.map(row => [row.principal, row.apiKey]));
  const active = new Set<string>(); let preflights = 0, transports = 0;
  return async (action: string, request: Request) => {
    const reply = (status: number) => new Response(null, { status, headers });
    if (!["view", "status-view", "mutate", "publish-wrap"].includes(action)) return reply(404);
    if (request.method !== "POST") return reply(405);
    if (!matchesBrowserOrigin(request, origin)) return reply(403);
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json" ||
        ![null, "identity"].includes(request.headers.get("content-encoding"))) return reply(415);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(4000)]);
    let principal: string | null = null, occupied = false, transport = false;
    try {
      if (preflights >= 2) return reply(429);
      preflights++;
      try { principal = await resolvePrincipal(request, signal); signal.throwIfAborted(); }
      finally { preflights--; }
      if (!principal || !credentials.has(principal)) return reply(403);
      if (active.has(principal)) return reply(429);
      active.add(principal); occupied = true;
      const body = await readBoundedIdentityJson(new Response(request.body), ["view", "status-view"].includes(action) ? 2048 : 100000,
        AbortSignal.any([signal, AbortSignal.timeout(1000)]));
      const keys = action === "view" ? ["object"] : action === "status-view" ? ["object", "reader"] : action === "mutate" ?
        ["object", "at", "fence", "operation", "payload"] : ["object", "at", "fence", "metadata", "wrapBase64"];
      if (!exact(body, keys) || typeof body.object !== "string" || !body.object.startsWith("media_") || !isCanonicalObjectId(body.object)) return reply(400);
      if (!["view", "status-view"].includes(action) && (!Number.isSafeInteger(body.at) || (body.at as number) < 0 || !digest(body.fence))) return reply(400);
      if (action === "status-view" && (typeof body.reader!=="string" || !isSeaPubkey(body.reader))) return reply(400);
      if (action === "mutate" && (typeof body.operation !== "string" || !["grant", "epoch", "status", "wrap"].includes(body.operation) ||
          !body.payload || typeof body.payload !== "object" || Array.isArray(body.payload))) return reply(400);
      if (action === "publish-wrap" && (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata) ||
          typeof body.wrapBase64 !== "string" || !body.wrapBase64.length || body.wrapBase64.length > 87384 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.wrapBase64))) return reply(400);
      if (transports >= 2) return reply(429);
      transports++; transport = true;
      const response = await fetcher(held.origin + "/api/v1/acl/sociacl/media/owner/" + action, {
        method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal,
        headers: { "X-Api-Key": credentials.get(principal)!, "X-Tenant-ID": held.tenant,
          "Content-Type": "application/json", "Accept-Encoding": "identity" }, body: JSON.stringify(body) });
      if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0] !== "application/json" ||
          ![null, "identity"].includes(response.headers.get("content-encoding"))) {
        await response.body?.cancel().catch(() => {}); return reply(response.status === 409 ? 409 : 403);
      }
      const result = await readBoundedIdentityJson(response, 262144, signal);
      if (action === "view") {
        if (!exact(result, ["at", "fence", "snapshot", "objectVersion", "owner", "bindings"]) || result.owner !== principal ||
            result.at !== Math.floor(clock()) || !digest(result.fence) || !Number.isSafeInteger(result.objectVersion) ||
            (result.objectVersion as number) < 0 || !exact(result.snapshot, ["entries"]) || !Array.isArray(result.snapshot.entries) ||
            result.snapshot.entries.length > 64 || !result.bindings || typeof result.bindings !== "object" || Array.isArray(result.bindings) ||
            Object.keys(result.bindings).length > 64) return reply(403);
      } else if (action === "status-view") {
        if (!exact(result,["at","fence","ownerPub","status"]) || result.at!==Math.floor(clock()) || !digest(result.fence) || typeof result.ownerPub!=="string" || !isSeaPubkey(result.ownerPub) ||
            !exact(result.status,["object","epoch","revisionId","accessor","grantRevision","stated","signedAt","maxAgeMs","zookie"])) return reply(403);
        const status=result.status;
        if (status.object!==body.object || status.accessor!==body.reader || status.signedAt!==(result.at as number)*1000 || status.stated!==1 ||
            !Number.isSafeInteger(status.epoch) || (status.epoch as number)<1 || !digest(status.revisionId) ||
            !Number.isSafeInteger(status.grantRevision) || (status.grantRevision as number)<1 || !Number.isSafeInteger(status.maxAgeMs) ||
            (status.maxAgeMs as number)<1 || (status.maxAgeMs as number)>60000 || !exact(status.zookie,["object","objectVersion","snapshotHash"]) ||
            status.zookie.object!==body.object || !Number.isSafeInteger(status.zookie.objectVersion) || (status.zookie.objectVersion as number)<0 ||
            !digest(status.zookie.snapshotHash)) return reply(403);
      } else if (action === "mutate") {
        if (!exact(result, ["accepted"]) || result.accepted !== true) return reply(403);
      } else if (!exact(result, ["record", "digest"]) || !digest(result.digest) || result.record !== result.digest ||
          result.digest !== (body.metadata as Record<string, unknown>).digest) return reply(403);
      if (await resolvePrincipal(request, signal) !== principal) return reply(403);
      signal.throwIfAborted();
      if (["view", "status-view"].includes(action) && (result as Record<string, unknown>).at !== Math.floor(clock())) return reply(403);
      return Response.json(result, { headers });
    } catch { return reply(503); }
    finally {
      if (occupied && principal) active.delete(principal);
      if (transport) transports--;
      if (!request.bodyUsed) void request.body?.cancel().catch(() => {});
    }
  };
}
