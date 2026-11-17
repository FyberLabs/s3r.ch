import { readBoundedIdentityJson } from "./identity/bounded-json";
import { createMediaWrapService, type MediaReaderConfig } from "./media-wrap-service";

export type MediaAgent = Readonly<{ principal: string; agent: string; delegationId: string }>;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Authorization, Cookie, Origin" };
const denied = (status = 403) => new Response(null, { status, headers });

/** Both subjects must independently possess a current wrap for the same revision.
 * Only the agent's encrypted wrap may leave this composition. No owner credential
 * is used for the agent lookup, and no write/control action is admitted here. */
export function createMediaAgentRead(config: MediaReaderConfig, origin: string,
  authenticate: (request: Request) => Promise<MediaAgent | null>,
  fetcher: typeof fetch = fetch, clock = () => Date.now() / 1000) {
  const bindings = new Set(config.readers.map(row => row.principal));
  let active = 0;
  return async (request: Request) => {
    if (request.method !== "POST") return denied(405);
    if (active >= 2) return denied(429);
    active++;
    try {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(4000)]);
      const bounded = new Request(request, { signal });
      const identity = await authenticate(bounded);
      signal.throwIfAborted();
      if (!identity || identity.agent === identity.principal ||
          !bindings.has(identity.agent) || !bindings.has(identity.principal)) return denied();
      if (request.headers.get("content-type")?.split(";")[0] !== "application/json" ||
          ![null, "identity"].includes(request.headers.get("content-encoding"))) return denied(415);
      const body = await readBoundedIdentityJson(new Response(bounded.body), 2048, signal);
      if (!body || typeof body !== "object" || Object.keys(body).join() !== "object") return denied(400);
      const fresh = async (input: Request) => {
        const current = await authenticate(input);
        signal.throwIfAborted();
        return current?.principal === identity.principal && current.agent === identity.agent &&
          current.delegationId === identity.delegationId;
      };
      const read = async (principal: string) => {
        const service = createMediaWrapService(config, origin,
          async input => await fresh(input) ? principal : null, fetcher, clock);
        const input = new Request(request.url, { method: "POST", headers: request.headers,
          body: JSON.stringify(body), signal });
        const response = await service(input);
        if (response.status !== 200) { await response.body?.cancel(); return null; }
        return await response.json() as { context: { object: string; epoch: number; revisionId: string }; expiresAt: number };
      };
      const before = await read(identity.principal);
      if (!before) return denied();
      const agent = await read(identity.agent);
      if (!agent) return denied();
      const after = await read(identity.principal);
      if (!after || !await fresh(bounded)) return denied();
      signal.throwIfAborted();
      const same = (other: typeof before) => other.context.object === agent.context.object &&
        other.context.epoch === agent.context.epoch && other.context.revisionId === agent.context.revisionId;
      if (!same(before) || !same(after) || Math.min(before.expiresAt, agent.expiresAt, after.expiresAt) <= clock()) return denied();
      return Response.json(agent, { headers });
    } catch { return denied(503); }
    finally { active--; }
  };
}
