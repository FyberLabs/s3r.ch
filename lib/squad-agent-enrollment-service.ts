import { createHash } from "node:crypto";
import { parseAgentDelegation, parseAgentRevocation } from "sociacl-ids";
import { createAclGraphSource, StatementSourceConflict, type ProtectedGraphSnapshot } from "./acl-graph-source-server";
import { agentSessionConfig } from "./identity/agent-session-config";
import { readBoundedIdentityText } from "./identity/bounded-json";
import { createForumAuthority, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { verifyForumKeySignature } from "./identity/forum-key-signature";
import { uniqueJson } from "./identity/forum-witness-json";
import { matchesBrowserOrigin } from "./request-origin";
import { roomAuthorityReadDiagnosticsBlock } from "./room-authority-diagnostics";
import { SQUAD_AGENT_GRANT_SECONDS, SQUAD_AGENT_SCOPE, type SquadAgentGrant } from "./squad-agent-enrollment";
import type { SquadPilotConfig } from "./squad-pilot-config";

type Journal = Pick<ReturnType<typeof createAclGraphSource>, "read" | "append">;
type Authenticator = (request: Request) => Promise<{ key: string } | null>;
type ForumReader = (at: number, signal: AbortSignal) => Promise<ForumAuthoritySnapshot>;
const exact = (row: unknown, keys: string): row is Record<string, unknown> =>
  !!row && typeof row === "object" && !Array.isArray(row) &&
  Object.keys(row).sort((left, right) => left.localeCompare(right, "en")).join() === keys;

function squadGrants(snapshot: ProtectedGraphSnapshot, owner: string, origin: string, noncePrefix: string, at: number) {
  if (snapshot.audience !== origin) throw Error("Wrong delegation audience");
  const grants: SquadAgentGrant[] = [];
  const cancelled = new Set<string>();
  for (const row of snapshot.rows) {
    if (!exact(row, "kind,record")) throw Error("Invalid delegation row");
    if (row.kind === "revocation") {
      const parsed = parseAgentRevocation(row.record);
      if (!parsed.ok) throw Error("Invalid revocation");
      if (parsed.value.revocation.principal === owner) cancelled.add(parsed.value.revocation.delegationId);
      continue;
    }
    const parsed = row.kind === "delegation" && parseAgentDelegation(row.record);
    if (!parsed || !parsed.ok) throw Error("Invalid delegation");
    const { id, delegation } = parsed.value;
    if (delegation.principal !== owner || delegation.audience !== origin || !delegation.nonce.startsWith(noncePrefix) ||
        delegation.scopes.length !== 1 || delegation.scopes[0] !== SQUAD_AGENT_SCOPE) continue;
    grants.push({ id, agent: delegation.agent, expiresAt: delegation.expiresAt,
      status: delegation.expiresAt > at ? "active" : "expired" });
  }
  return grants.map(grant => cancelled.has(grant.id) ? { ...grant, status: "revoked" as const } : grant);
}

export function createSquadAgentEnrollmentService(input: {
  pilot: SquadPilotConfig;
  journal: Journal;
  authenticate: Authenticator;
  read: ForumReader;
  clock?: () => number;
}) {
  const { pilot, journal, authenticate, read } = input;
  const { forumId, owner } = pilot.squad;
  const origin = new URL(pilot.origin);
  // The owner signs this nonce as part of the existing delegation format.
  // It identifies the Squad's approvals even when the current roster changes.
  const noncePrefix = createHash("sha256").update(JSON.stringify(["s3rch-squad-enrollment-v1", forumId])).digest("hex").slice(0, 32);
  const roster = new Set(Object.values(pilot.plane?.roster ?? {}).filter(key => key !== owner));
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const reply = (status: number, body: object) => Response.json(body, { status, headers: {
    "Cache-Control": "private, no-store", Vary: "Cookie, Origin", "X-Content-Type-Options": "nosniff",
  } });
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST" || request.headers.has("authorization") || !matchesBrowserOrigin(request, origin) ||
        request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
      return reply(403, { error: "origin-or-type" });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]);
    let body: unknown;
    try { body = uniqueJson(await readBoundedIdentityText(new Response(request.body), 4_096, signal)); }
    catch { return reply(400, { error: "request" }); }
    if (!exact(body, "action,forum") && !exact(body, "action,forum,record"))
      return reply(400, { error: "request" });
    if (body.forum !== forumId) return reply(404, { error: "squad" });
    const list = body.action === "list" && !("record" in body);
    const change = (body.action === "approve" || body.action === "revoke") && "record" in body;
    if (!list && !change) return reply(400, { error: "request" });
    try {
      const session = await authenticate(request);
      if (!session) return reply(403, { error: "owner-required" });
      const at = clock();
      const snapshot = await read(at, signal);
      const authority = createForumAuthority(pilot.authority, clock);
      const verified = await authority.refresh(snapshot, at);
      if (!verified.ok || roomAuthorityReadDiagnosticsBlock(verified.diagnostics, snapshot))
        return reply(503, { error: "authority-unavailable" });
      if (authority.graph.ownerOf(forumId) !== owner || authority.graph.principalForKey(session.key, at) !== owner)
        return reply(403, { error: "owner-required" });
      const agents = [...roster].filter(key => authority.graph.checkForumSee(forumId, key, at).allowed &&
        authority.graph.checkPost(forumId, key, at).allowed);
      const current = await journal.read(at, signal);
      const grants = squadGrants(current.snapshot, owner, origin.origin, noncePrefix, at);
      const guard = () => { signal.throwIfAborted(); if (clock() !== at) throw new StatementSourceConflict(); };
      guard();
      if (list) return reply(200, { owner, evaluatedAt: at, noncePrefix, agents, grants });
      if (body.action === "approve") {
        const signed = parseAgentDelegation(body.record);
        if (!signed.ok) return reply(400, { error: "delegation" });
        const { delegation, bytes, id } = signed.value;
        if (delegation.principal !== owner || !agents.includes(delegation.agent) || delegation.audience !== origin.origin ||
            !delegation.nonce.startsWith(noncePrefix) ||
            delegation.scopes.length !== 1 || delegation.scopes[0] !== SQUAD_AGENT_SCOPE ||
            !verifyForumKeySignature(session.key, delegation.sig, bytes)) return reply(403, { error: "delegation" });
        if (grants.some(row => row.id === id)) return reply(200, { id });
        if (delegation.issuedAt > at || at - delegation.issuedAt > 60 || delegation.expiresAt - delegation.issuedAt > SQUAD_AGENT_GRANT_SECONDS ||
            grants.some(row => row.agent === delegation.agent && row.status === "active")) return reply(409, { error: "delegation" });
        return await journal.append(current.fence, [{ kind: "delegation", record: delegation }], guard, signal)
          ? reply(200, { id }) : reply(409, { error: "changed" });
      }
      const signed = parseAgentRevocation(body.record);
      if (!signed.ok) return reply(400, { error: "revocation" });
      const { revocation, bytes } = signed.value;
      const grant = grants.find(row => row.id === revocation.delegationId);
      if (!grant || revocation.principal !== owner ||
          !verifyForumKeySignature(session.key, revocation.sig, bytes)) return reply(403, { error: "revocation" });
      if (grant.status === "revoked") return reply(200, { id: grant.id });
      if (revocation.issuedAt > at || at - revocation.issuedAt > 60) return reply(409, { error: "revocation" });
      return await journal.append(current.fence, [{ kind: "revocation", record: revocation }], guard, signal)
        ? reply(200, { id: grant.id }) : reply(409, { error: "changed" });
    } catch (error) {
      return error instanceof StatementSourceConflict ? reply(409, { error: "changed" }) : reply(503, { error: "enrollment-unavailable" });
    }
  };
}

export function configuredSquadAgentEnrollment(pilot: SquadPilotConfig, authenticate: Authenticator, read: ForumReader) {
  const writer = process.env.S3RCH_SQUAD_DELEGATION_WRITE_API_KEY;
  if (!writer || !pilot.plane) return null;
  const config = agentSessionConfig(pilot.origin, process.env);
  if (!config || config.source.tenant !== pilot.plane.tenant ||
      config.source.tenant !== process.env.S3RCH_IDENTITY_REPLAY_TENANT_ID || writer === config.source.apiKey)
    throw Error("Squad delegation writer requires a separate, tenant-bound credential");
  const reader = createAclGraphSource(config.source, "delegations");
  const journal = createAclGraphSource({ ...config.source, apiKey: writer }, "delegations");
  return createSquadAgentEnrollmentService({ pilot, authenticate, read, journal: { read: reader.read, append: journal.append } });
}
