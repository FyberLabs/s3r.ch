import { createForumAuthority, type ForumAuthorityConfig, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { parseForumAuthority, type ParsedAuthority } from "./identity/forum-authority-records";
import { isForumObjectId, sameEmbeddedPrincipal } from "./identity/forum-check";
import { matchesBrowserOrigin } from "./request-origin";
import type { LiveSquadSpec } from "./squad-view";
export type BotStatementSource = Readonly<{
  /** A provisioned primary snapshot and its opaque concurrency fence. Never Gun. */
  read(at: number, signal: AbortSignal): Promise<{ snapshot: ForumAuthoritySnapshot; fence: string }>;
  /** Atomically retain the rows only if ALL history/ACL inputs still match fence.
   * Must not mint enrollment, discard history, or restamp imported completeness. */
  append(fence: string, rows: ForumAuthoritySnapshot["rows"], guard: () => void, signal: AbortSignal): Promise<boolean>;
}>;
/** Additive provider interface. Deployment must explicitly supply its atomic
 * source; no missing provider falls back to the legacy assignment journal.
 */
export function createBotStatementAdmission(input: { origin: string; squad: LiveSquadSpec; config: ForumAuthorityConfig;
  authenticate(request: Request): Promise<{ key: string } | null>; source: BotStatementSource; clock?: () => number }) {
  const origin = new URL(input.origin), spec = Object.freeze({ ...input.squad }), config = structuredClone(input.config);
  if (origin.origin !== input.origin || origin.protocol !== "https:") throw Error("HTTPS statement origin required");
  const { authenticate, source } = input, clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const reply = (status: number) => Response.json({ ok: status === 200 }, { status, headers: { "Cache-Control": "no-store" } });
  const readers = new Map<string, number>(); let active = 0;
  return async (request: Request) => {
    let reserved: string | null = null;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 1500);
    const signal = AbortSignal.any([request.signal, deadline.signal]);
    const bounded = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => reject(new Error("Statement admission timed out"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
    try {
      if (request.method !== "POST" || !matchesBrowserOrigin(request, origin) ||
          request.headers.get("content-type")?.split(";")[0] !== "application/json" || !request.body) return reply(403);
      const at = clock(), session = await bounded(authenticate(request)); if (!session) return reply(403);
      if (active >= 16 || (readers.get(session.key) ?? 0) >= 2) return reply(429);
      reserved = session.key; active++; readers.set(reserved, (readers.get(reserved) ?? 0) + 1);
      const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      let timedOut = false; const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 800);
      try { for (;;) { request.signal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
        size += part.value.length; if (size > 65536) { await reader.cancel(); return reply(413); } chunks.push(part.value); }
      } finally { clearTimeout(timer); reader.releaseLock(); }
      if (timedOut || clock() !== at) return reply(409);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || Object.keys(body).sort().join() !== "evaluatedAt,forumId,owner,rows,version" || body.version !== 1 ||
          body.forumId !== spec.forumId || body.owner !== spec.owner || body.evaluatedAt !== at ||
          !Array.isArray(body.rows) || body.rows.length > 65) return reply(400);
      const held = await bounded(source.read(at, signal));
      if (typeof held.fence !== "string" || !held.fence || held.fence.length > 4096) return reply(503);
      const snapshot = structuredClone(held.snapshot);
      const responseSize = (value: ForumAuthoritySnapshot) => Buffer.byteLength(JSON.stringify({ version: 1,
        forumId: spec.forumId, owner: spec.owner, evaluatedAt: at, snapshot: value }), "utf8");
      if (!Array.isArray(snapshot.rows) || snapshot.rows.length > 1024 || responseSize(snapshot) > 4 * 1024 * 1024) return reply(507);
      const authority = createForumAuthority(config, clock), verified = await authority.refresh(snapshot, at);
      const principal = authority.graph.principalForKey(session.key, at);
      if (!verified.ok || verified.diagnostics.length || !principal || authority.graph.ownerOf(spec.forumId) !== spec.owner ||
          !authority.graph.checkForumSee(spec.forumId, principal, at).allowed || !authority.graph.checkPost(spec.forumId, principal, at).allowed)
        return reply(403);
      if (body.rows.length === 0) return reply(200); // Authenticated provider readiness; no mutation.
      const parsed = body.rows.map((row: any) => {
        if (!row || Object.keys(row).sort().join() !== "kind,record,soul") throw Error("Invalid authority envelope");
        const value = parseForumAuthority(row.kind, row.record);
        if (!value || value.soul !== row.soul || !["object", "see"].includes(value.kind)) throw Error("Invalid statement authority");
        return value;
      });
      const objects = new Set(parsed.map((p: any) => p.row.object));
      if (objects.size !== 1) return reply(400);
      const object = [...objects][0];
      if (typeof object !== "string" || !isForumObjectId(object, "stmt") || !sameEmbeddedPrincipal(principal, object)) return reply(403);
      for (const p of parsed) {
        const row = p.row;
        if (row.owner !== principal || row.issuedAt > at) return reply(403);
        if (p.kind === "see" && (p.row.until > at + 3600 || (p.row.stated === 1 &&
            !authority.graph.checkForumSee(spec.forumId, p.row.accessor, at).allowed))) return reply(403);
      }
      // Canonical signed meaning, not object key order or signature encoding,
      // identifies a retained row. Verify supplied signatures even on retries.
      const identity = (row: ParsedAuthority) => JSON.stringify([row.kind, row.soul, Buffer.from(row.bytes).toString("base64")]);
      const seen = new Set(snapshot.rows.map(row => {
        const value = parseForumAuthority(row.kind, row.record);
        if (!value) throw Error("Invalid retained authority"); return identity(value);
      }));
      const additions = body.rows.filter((_row: unknown, index: number) => {
        const key = identity(parsed[index]); if (seen.has(key)) return false; seen.add(key); return true;
      });
      // The same complete-history fence makes the aggregate check atomic.
      const nextSnapshot = { ...snapshot, rows: [...snapshot.rows, ...additions] };
      if (nextSnapshot.rows.length > 1024 || responseSize(nextSnapshot) > 4 * 1024 * 1024) return reply(507);
      const candidate = createForumAuthority(config, clock);
      const result = await candidate.refresh({ ...snapshot, rows: [...snapshot.rows, ...body.rows] }, at);
      if (!result.ok || result.diagnostics.length || candidate.graph.ownerOf(object) !== principal) return reply(403);
      const guard = () => { signal.throwIfAborted(); if (clock() !== at) throw Error("Statement authority expired"); };
      guard();
      if (additions.length === 0) return reply(200);
      return reply(await bounded(source.append(held.fence, structuredClone(additions), guard, signal)) ? 200 : 409);
    } catch { return reply(503); } finally {
      clearTimeout(timer); deadline.abort();
      if (reserved !== null) { active--; const count = (readers.get(reserved) ?? 1) - 1; if (count) readers.set(reserved, count); else readers.delete(reserved); }
    }
  };
}
