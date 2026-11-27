import { roomAuthorityReadDiagnosticsBlock } from "./room-authority-diagnostics";
import { matchesBrowserOrigin } from "./request-origin";
import { createForumAuthority, type ForumAuthorityConfig, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { squadView, isPublicSquadPrincipal, type LiveSquadSpec } from "./squad-view";

/** Server dependencies only. authenticate must prove possession of the session's
 * SEA key (a wallet address or caller-supplied pubkey is not authentication).
 * read must supply a complete atomic snapshot for this provisioned namespace,
 * with history changes serialized against the ACL journal. Never assemble it
 * from independently read histories and arbitrary Gun rows.
 */
export function createForumAuthorityService(input: {
  squad: LiveSquadSpec;
  origin: string;
  config: ForumAuthorityConfig;
  authenticate(request: Request): Promise<{ key: string } | null>;
  read(at: number, signal: AbortSignal): Promise<ForumAuthoritySnapshot>;
  clock?: () => number;
}) {
  const view = squadView(input.squad);
  if (!view.live) throw Error("Live Squad required");
  const origin = new URL(input.origin);
  if (origin.origin !== input.origin || !["http:", "https:"].includes(origin.protocol)) throw Error("Canonical origin required");
  const config = structuredClone(input.config), { authenticate, read } = input;
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const reply = (status: number, body: unknown) => Response.json(body, { status,
    headers: { "Cache-Control": "no-store", Vary: "Cookie, Authorization, Origin", "X-Content-Type-Options": "nosniff" } });
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== "POST") return reply(405, { error: "method" });
      if (!matchesBrowserOrigin(request, origin) ||
          request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return reply(403, { error: "origin-or-type" });
      const at = clock();
      const session = await authenticate(request);
      if (clock() !== at) return reply(409, { error: "scope-or-time" });
      if (!session || typeof session.key !== "string" || isPublicSquadPrincipal(session.key)) return reply(403, { error: "authentication" });
      const key = session.key;
      if (!request.body) return reply(400, { error: "request" });
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      const abort = () => { void reader.cancel().catch(() => {}); };
      request.signal.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          request.signal.throwIfAborted();
          const part = await reader.read();
          request.signal.throwIfAborted();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 2048) { await reader.cancel(); return reply(413, { error: "request-size" }); }
          chunks.push(part.value);
        }
      } finally { request.signal.removeEventListener("abort", abort); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let body;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { return reply(400, { error: "request" }); }
      if (clock() !== at) return reply(409, { error: "scope-or-time" });
      if (!body || Object.keys(body).sort().join() !== "evaluatedAt,forumId,owner,version" || body.version !== 1 ||
          body.forumId !== view.forumId || body.owner !== view.owner || !Number.isSafeInteger(body.evaluatedAt) ||
          body.evaluatedAt < 0 || Object.is(body.evaluatedAt, -0) || body.evaluatedAt !== at) return reply(409, { error: "scope-or-time" });
      request.signal.throwIfAborted();
      // Copy once: verify and return the identical evidence, even if the trusted
      // reader reuses mutable objects across concurrent calls.
      const snapshot = structuredClone(await read(at, request.signal));
      const encoded = JSON.stringify({ version: 1, forumId: view.forumId, owner: view.owner, evaluatedAt: at, snapshot });
      if (new TextEncoder().encode(encoded).byteLength > 4 * 1024 * 1024 || !Array.isArray(snapshot.rows) || snapshot.rows.length > 1024)
        return reply(503, { error: "capacity" });
      const authority = createForumAuthority(config, clock);
      const result = await authority.refresh(snapshot, at);
      request.signal.throwIfAborted();
      const principal = authority.graph.principalForKey(key, at);
      if (!result.ok || roomAuthorityReadDiagnosticsBlock(result.diagnostics, snapshot) || clock() !== at || authority.graph.ownerOf(view.forumId) !== view.owner)
        return reply(503, { error: "authority-unavailable" });
      if (!principal || isPublicSquadPrincipal(principal) || !authority.graph.checkForumSee(view.forumId, principal, at).allowed)
        return reply(403, { error: "access" });
      return new Response(encoded, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
        Vary: "Cookie, Authorization, Origin", "X-Content-Type-Options": "nosniff" } });
    } catch { return reply(503, { error: "authority-unavailable" }); }
  };
}
