import { objectPrincipal } from "./identity/forum-authority-records";
import { matchesBrowserOrigin } from "./request-origin";
import { RecordConflict } from "./record-store";
import { createMediaRegistrationStore, mediaRegistration, MediaRegistrationCapacity } from "./media-registration-store";
import type { UnverifiedObjectRecord } from "./identity/forum-object-record";

/** Registers signed private ownership only; it does not publish a post, grant
 * a reader, issue a wrap, or enroll an identity into the trusted history source. */
export function createMediaRegistrationService(input: {
  preflight(request: Request, object: string, signal: AbortSignal): Promise<boolean>;
  origin: string; store: ReturnType<typeof createMediaRegistrationStore>;
  authorize(request: Request, object: string, action: "write", signal: AbortSignal, candidate: UnverifiedObjectRecord): Promise<boolean>;
}) {
  const origin = new URL(input.origin);
  if (origin.origin !== input.origin || origin.protocol !== "https:") throw Error("Canonical HTTPS origin required");
  let active = 0, preflights = 0;
  const owners = new Map<string, number>();
  return async (request: Request, object: string) => {
    const reply = (status: number) => new Response(null, { status, headers: {
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie, Authorization, Origin" } });
    if (!["POST", "DELETE"].includes(request.method)) return reply(405);
    if (!matchesBrowserOrigin(request, origin)) return reply(403);
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" ||
        ![null, "identity"].includes(request.headers.get("content-encoding"))) return reply(415);
    if (!request.body) return reply(400);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
    if (preflights >= 2) { void request.body.cancel().catch(() => {}); return reply(429); }
    preflights++;
    try {
      signal.throwIfAborted();
      if (!await input.preflight(request, object, signal)) {
        void request.body.cancel().catch(() => {}); return reply(403);
      }
      signal.throwIfAborted();
    } catch { void request.body.cancel().catch(() => {}); return reply(503); }
    finally { preflights--; }
    // Preflight binds the session to this canonical embedded owner. Different
    // objects owned by the same principal must share the same admission bucket.
    const owner = object.startsWith("media_") && objectPrincipal(object);
    if (!owner) { void request.body.cancel().catch(() => {}); return reply(403); }
    if (active >= 16 || (owners.get(owner) ?? 0) >= 2) {
      void request.body.cancel().catch(() => {}); return reply(429);
    }
    active++;
    owners.set(owner, (owners.get(owner) ?? 0) + 1);
    try {
      const reader = request.body.getReader(), bytes = new Uint8Array(2048); let size = 0;
      const abort = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
          if (part.done) break;
          if (size + part.value.length > bytes.length) return reply(413);
          bytes.set(part.value, size); size += part.value.length;
        }
      } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
      let record;
      try { record = mediaRegistration(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, size)))); }
      catch { return reply(400); }
      if (!record || record.object !== object) return reply(400);
      const authorized = () => input.authorize(request, object, "write", signal, record);
      if (!await authorized()) return reply(403);
      if (request.method === "DELETE") await input.store.remove(object, signal, authorized);
      else await input.store.admit(record, signal, authorized);
      if (!await authorized()) return reply(403);
      signal.throwIfAborted();
      return reply(request.method === "DELETE" ? 204 : 201);
    } catch (error) {
      return reply(error instanceof RecordConflict ? 409 : error instanceof MediaRegistrationCapacity ? 507 : 503);
    } finally {
      active--;
      const remaining = owners.get(owner)! - 1;
      if (remaining) owners.set(owner, remaining); else owners.delete(owner);
    }
  };
}
