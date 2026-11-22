import { matchesBrowserOrigin, matchesRequestOrigin } from "./request-origin";
import { roomAuthorityReadDiagnosticsBlock } from "./room-authority-diagnostics";
import { createForumAuthority, type ForumAuthorityConfig, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { authenticateAgentRequest } from "./identity/site-agent-session-server";
import { isPublicSquadPrincipal, type LiveSquadSpec } from "./squad-view";
import {
  parseVisorCompanionResolveRequest,
  resolveVisorCompanionSquad,
  VISOR_COMPANION_AGENT_SCOPE,
  visorCompanionEvaluatedAtWithinSkew,
  type VisorCompanionSetStore,
} from "./visor-companion-squad";

export function createVisorCompanionSquadService(input: {
  squad: LiveSquadSpec;
  origin: string;
  config: ForumAuthorityConfig;
  tenant: string;
  store: VisorCompanionSetStore;
  authenticate(request: Request): Promise<{ key: string } | null>;
  authenticateAgent?: (request: Request) => Promise<{ principal: string; agent: string; delegationId: string; scopes: readonly string[] } | null>;
  read(at: number, signal: AbortSignal): Promise<ForumAuthoritySnapshot>;
  clock?: () => number;
}) {
  const origin = new URL(input.origin);
  if (origin.origin !== input.origin || origin.protocol !== "https:") throw Error("HTTPS origin required");
  const spec = Object.freeze({ ...input.squad }), config = structuredClone(input.config);
  const { authenticate, read, store, tenant } = input;
  const authenticateAgent = input.authenticateAgent
    ?? (request => authenticateAgentRequest(request, [VISOR_COMPANION_AGENT_SCOPE]));
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const reply = (status: number, body: unknown) => Response.json(body, { status, headers: {
    "Cache-Control": "no-store", Vary: "Cookie, Authorization, Origin", "X-Content-Type-Options": "nosniff" } });
  return async (request: Request): Promise<Response> => {
    try {
      const agentRequest = request.headers.has("authorization");
      const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (request.method !== "POST" || contentType !== "application/json") return reply(403, { error: "origin-or-type" });
      if (agentRequest ? !matchesRequestOrigin(request, origin) : !matchesBrowserOrigin(request, origin)) {
        return reply(403, { error: "origin-or-type" });
      }
      if (!request.body) return reply(400, { error: "request" });
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const abort = () => { void reader.cancel().catch(() => {}); };
      const bodySignal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]);
      bodySignal.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          bodySignal.throwIfAborted();
          const part = await reader.read();
          bodySignal.throwIfAborted();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 8192) { abort(); return reply(413, { error: "request-size" }); }
          chunks.push(part.value);
        }
      } catch (error) {
        if (bodySignal.reason?.name === "TimeoutError") return reply(408, { error: "request-timeout" });
        throw error;
      } finally { bodySignal.removeEventListener("abort", abort); reader.releaseLock(); }
      let body: unknown;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { return reply(400, { error: "request" }); }
      const parsed = parseVisorCompanionResolveRequest(body);
      if (!parsed) return reply(400, { error: "request" });
      const agent = agentRequest ? await authenticateAgent(request) : null;
      if (agentRequest && !agent) return reply(403, { error: "authentication" });
      const browser = agentRequest ? null : await authenticate(request);
      const ownerKey = agent?.principal ?? browser?.key;
      if (!ownerKey || isPublicSquadPrincipal(ownerKey)) return reply(403, { error: "authentication" });
      const evaluatedAt = clock();
      if (!visorCompanionEvaluatedAtWithinSkew(parsed.evaluatedAt, evaluatedAt)) return reply(409, { error: "scope-or-time" });
      request.signal.throwIfAborted();
      const snapshot = structuredClone(await read(evaluatedAt, request.signal));
      if (!snapshot || !Array.isArray(snapshot.rows) || snapshot.rows.length > 1024 ||
          !snapshot.history || !Number.isSafeInteger(snapshot.completeThrough)) return reply(503, { error: "authority-unavailable" });
      const authority = createForumAuthority(config, clock);
      const verified = await authority.refresh(snapshot, evaluatedAt);
      if (!verified.ok || roomAuthorityReadDiagnosticsBlock(verified.diagnostics, snapshot)) {
        return reply(503, { error: "authority-unavailable" });
      }
      const ownerPrincipal = agent ? ownerKey : authority.graph.principalForKey(ownerKey, evaluatedAt);
      if (!ownerPrincipal) return reply(403, { error: "authentication" });
      if (agent && !authority.graph.checkForumSee(spec.forumId, agent.agent, evaluatedAt).allowed) {
        return reply(403, { error: "authentication" });
      }
      const result = await resolveVisorCompanionSquad({
        squad: spec, origin: origin.origin, authority: config, tenant, ownerPrincipal, evaluatedAt,
        request: parsed, snapshot, store, clock,
        authorizeWrite: async () => {
          request.signal.throwIfAborted();
          if (!agent) return true;
          const current = await authenticateAgent(request);
          return current?.principal === agent.principal && current.agent === agent.agent &&
            current.delegationId === agent.delegationId;
        },
      });
      if (!result.ok) {
        const status = result.reason === "scope-or-time" ? 409
          : result.reason === "stale-generation" ? 409
          : result.reason === "authority" ? 503
          : 403;
        return reply(status, { error: result.reason });
      }
      const encoded = JSON.stringify(result.body);
      if (new TextEncoder().encode(encoded).byteLength > 65536) return reply(507, { error: "capacity" });
      return new Response(encoded, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
        Vary: "Cookie, Authorization, Origin", "X-Content-Type-Options": "nosniff" } });
    } catch { return reply(503, { error: "visor-companion-unavailable" }); }
  };
}