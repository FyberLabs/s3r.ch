import { createDelegationRuntime } from "./delegation-runtime";
import type { createSquadCommitStore } from "./squad-commit-store";
import { createForumAuthority } from "./identity/forum-authority";
import { isSeaPubkey, isForumObjectId } from "./identity/forum-check";
import { squadView, isPublicSquadPrincipal, type LiveSquadSpec } from "./squad-view";

type Action = "read" | "start" | "resume" | "abort" | "read-child" | "child";
const fields = { read: "forum,owner", start: "forum,operationId,owner,replacement,revision", resume: "forum,operationId,owner,replacement",
  abort: "forum,operationId,owner", "read-child": "forum,id,owner", child: "forum,owner,record,signature" };
/** Fixed deployment scope; authenticate is the SEA cookie authenticator, never
 * a wallet address or an actor supplied by the request. Each call opens its own
 * shared history/journal view so writes remain fenced against history changes. */
export function createSquadAssignmentService(input: {
  squad: LiveSquadSpec; origin: string; source: ReturnType<typeof createSquadCommitStore>;
  authenticate(request: Request): Promise<{ key: string } | null>;
  runtime: Omit<Parameters<typeof createDelegationRuntime>[0], "journal" | "history">;
}) {
  const view = squadView(input.squad), origin = new URL(input.origin);
  if (!view.live || origin.origin !== input.origin || origin.protocol !== "https:") throw Error("Fixed HTTPS Squad required");
  const { source, authenticate } = input;
  const options = { ...input.runtime, config: structuredClone(input.runtime.config) };
  const clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
  const reply = (status: number, body: unknown) => Response.json(body, { status,
    headers: { "Cache-Control": "no-store", Vary: "Cookie, Origin", "X-Content-Type-Options": "nosniff" } });
  return async (action: Action, request: Request): Promise<Response> => {
    try {
      if (!Object.hasOwn(fields, action)) return reply(404, { error: "action" });
      if (request.method !== "POST") return reply(405, { error: "method" });
      if (new URL(request.url).origin !== origin.origin || request.headers.get("origin") !== origin.origin ||
          request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return reply(403, { error: "origin-or-type" });
      const session = await authenticate(request);
      if (!session || !isSeaPubkey(session.key) || isPublicSquadPrincipal(session.key)) return reply(403, { error: "authentication" });
      const sessionKey = session.key;
      if (!request.body) return reply(400, { error: "request" });
      const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const abort = () => { void reader.cancel().catch(() => {}); };
      request.signal.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          request.signal.throwIfAborted(); const part = await reader.read(); request.signal.throwIfAborted();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 131072) { await reader.cancel(); return reply(413, { error: "request-size" }); }
          chunks.push(part.value);
        }
      } finally { request.signal.removeEventListener("abort", abort); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let body;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return reply(400, { error: "request" }); }
      if (!body || Object.keys(body).sort().join() !== fields[action] || body.forum !== view.forumId || body.owner !== view.owner) return reply(400, { error: "scope-or-fields" });
      if (["start", "resume", "abort"].includes(action) && (typeof body.operationId !== "string" || !/^[0-9a-f]{32}$/.test(body.operationId))) return reply(400, { error: "operation" });
      if (["start", "resume"].includes(action) && (!isSeaPubkey(body.replacement) || isPublicSquadPrincipal(body.replacement))) return reply(400, { error: "replacement" });
      if (action === "start" && (!Number.isSafeInteger(body.revision) || body.revision < 0)) return reply(400, { error: "revision" });
      if (action === "read-child" && !isForumObjectId(body.id)) return reply(400, { error: "child" });
      if (action === "child" && (typeof body.signature !== "string" || body.signature.length > 32768)) return reply(400, { error: "signature" });
      const at = clock();
      const evaluationClock = () => { request.signal.throwIfAborted(); if (clock() !== at) throw Error("evaluation expired"); return at; };
      const pinned = await source.open(evaluationClock), state = await pinned.journal.load();
      if (state.forum !== view.forumId || state.owner !== view.owner) return reply(503, { error: "source-scope" });
      const authority = createForumAuthority(options.config, clock);
      const verified = await authority.refresh({ completeThrough: at, rows: state.rows, history: await pinned.history(at) }, at);
      const actor = authority.graph.principalForKey(sessionKey, at);
      if (!verified.ok || verified.diagnostics.length || authority.graph.ownerOf(view.forumId) !== view.owner) return reply(503, { error: "authority" });
      if (!actor || isPublicSquadPrincipal(actor)) return reply(403, { error: "principal" });
      if (!["child", "read-child"].includes(action) && actor !== view.owner) return reply(403, { error: "owner" });
      // Do not re-resolve a retired session key as a stable actor in a later
      // evaluation second. New requests reauthenticate against a fresh view.
      evaluationClock();
      const runtime = createDelegationRuntime({ ...options, ...pinned, clock: evaluationClock });
      if (action === "read") {
        const s = await runtime.read(actor);
        return reply(200, { forum: s.forum, owner: s.owner, assignee: s.assignee, revision: s.revision, operation: s.operation, receipts: s.receipts });
      }
      if (action === "start") return reply(200, await runtime.start(actor, body.operationId, body.replacement, body.revision));
      if (action === "resume") return reply(200, await runtime.resume(actor, body.operationId, body.replacement));
      if (action === "abort") { await runtime.abort(actor, body.operationId); return reply(200, { ok: true }); }
      if (action === "read-child") return reply(200, await runtime.readChild(actor, body.id));
      await runtime.publishChild(actor, state.revision, body.record, body.signature);
      return reply(200, { ok: true });
    } catch { return reply(409, { error: "assignment-or-evidence-changed" }); }
  };
}
