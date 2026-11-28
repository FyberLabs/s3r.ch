import { roomAuthorityDiagnosticsBlock, roomAuthorityReadDiagnosticsBlock } from "./room-authority-diagnostics";
import { configuredAclStatementSource, StatementSourceConflict } from "./acl-statement-source-server";
import type { BotStatementSource } from "./forum-bot-statement-admission";
import { configuredIdentityReplay, type IdentityReplay } from "./identity/spanopticon-replay-server";
import { getIdentitySecret } from "./identity/secret";
import { resolveSiteOrigin } from "./site-origin";
import { SEA_OWNED_FORUM_AUTHORITY } from "./sea-owned-forum-policy";
import { createForumAuthority, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { createBotStatementAdmission } from "./forum-bot-statement-admission";
import { createForumAuthorityService } from "./forum-authority-service";
import { createIdentityTokenVerifier } from "./identity/sea-session-verifier";
import { readSeaSessionCookie } from "./identity/sea-session-http";
import { identitySessionNamespace } from "./identity/replay-namespace";
import { createRoomMeetingSignaling } from "./room-meeting-signaling-server";

export type SquadForumServer = Readonly<{
  backend: "acl";
  origin: string;
  config: typeof SEA_OWNED_FORUM_AUTHORITY;
  source: { read(at: number, signal: AbortSignal): Promise<ForumAuthoritySnapshot> };
  statements: BotStatementSource;
  services: Readonly<{
    authenticate(request: Request): Promise<{ key: string } | null>;
    authority: ReturnType<typeof createForumAuthorityService>;
    statements: ReturnType<typeof createBotStatementAdmission>;
    rooms: ReturnType<typeof createBotStatementAdmission>;
    meeting?: ReturnType<typeof createRoomMeetingSignaling>;
  }>;
  meeting?: ReturnType<typeof createRoomMeetingSignaling>;
}>;

export function createSquadForumServer(
  origin: string,
  statements: BotStatementSource,
  replay: IdentityReplay | undefined,
  clock = () => Math.floor(Date.now() / 1000),
  identitySecret = getIdentitySecret({ S3RCH_SESSION_SIGNING_KEY: process.env.S3RCH_SESSION_SIGNING_KEY, NODE_ENV: "production" }),
  tenant = process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID,
): SquadForumServer {
  if (!statements) throw Error("ACL statement source is required");
  if (!replay) throw Error("Squad forum requires configured identity replay");
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== "https:") throw Error("Canonical HTTPS origin required");
  const source = { read: async (at: number, signal: AbortSignal) => (await statements.read(at, signal)).snapshot };
  const verifier = createIdentityTokenVerifier({ origin, secret: identitySecret, clock });
  const authenticate = async (request: Request) => {
    const token = readSeaSessionCookie(request);
    return token ? verifier.authenticate(token) : null;
  };
  const common = { origin, config: SEA_OWNED_FORUM_AUTHORITY, clock, authenticate };
  const meeting = tenant
    ? createRoomMeetingSignaling({
      origin,
      tenant,
      async verify(token) {
        const proof = await verifier.claims(token, "s3rch-identity-session-v1", 300);
        return { ...proof, expiresAt: proof.expiresAt * 1000 };
      },
      async authority(room, signal) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const at = clock();
          let snapshot;
          try { snapshot = await source.read(at, signal); }
          catch (error) {
            if (error instanceof StatementSourceConflict && clock() > at) continue;
            throw error;
          }
          const authority = createForumAuthority(SEA_OWNED_FORUM_AUTHORITY, clock);
          const verified = await authority.refresh(snapshot, at);
          signal.throwIfAborted();
          if (clock() > at) continue;
          const { graph } = authority;
          if (clock() !== at || !verified.ok) break;
          if (roomAuthorityReadDiagnosticsBlock(verified.diagnostics, snapshot)) break;
          return {
            current: () => clock() === at && !signal.aborted,
            principal(key) {
              const principal = graph.principalForKey(key, at);
              return principal && graph.writerKey(principal, at, at) === key ? principal : null;
            },
            mayJoin(principal) {
              return graph.checkForumSee(room, principal, at).allowed;
            },
          };
        }
        throw Error("Meeting room authority unavailable");
      },
    })
    : undefined;
  const services = Object.freeze({
    authenticate,
    ...(meeting ? { meeting } : {}),
    authority: createForumAuthorityService({ ...common, read: source.read }),
    statements: createBotStatementAdmission({ ...common, source: statements }),
    rooms: createBotStatementAdmission({ ...common, source: statements, objectKind: "room" }),
  });
  return Object.freeze({ backend: "acl", origin, config: SEA_OWNED_FORUM_AUTHORITY, source, statements, services, ...(meeting ? { meeting } : {}) });
}

let cached: { identity: string; server: SquadForumServer } | undefined;

/** Lazy squad forum runtime. Never enables a site-wide witness policy from deployment env. */
export function getSquadForumServer(): SquadForumServer | null {
  const identity = JSON.stringify([
    process.env.S3RCH_SESSION_SIGNING_KEY, process.env.S3RCH_SITE_ORIGIN,
    process.env.S3RCH_IDENTITY_REPLAY_BACKEND, process.env.S3RCH_IDENTITY_REPLAY_ORIGIN,
    process.env.S3RCH_IDENTITY_REPLAY_TENANT_ID, process.env.S3RCH_SERVICE_CREDENTIAL,
    process.env.S3RCH_AUTHORITY_BACKEND, process.env.S3RCH_STATEMENT_SOURCE_ORIGIN,
    process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID, process.env.S3RCH_STATEMENT_SOURCE_SCOPE,
    process.env.S3RCH_STATEMENT_SOURCE_KEY_VAULT_URI, process.env.AZURE_CLIENT_ID,
  ]);
  if (cached?.identity === identity) return cached.server;
  cached = undefined;
  if (process.env.S3RCH_AUTHORITY_BACKEND !== "acl") return null;
  const origin = resolveSiteOrigin(process.env);
  if (!origin) return null;
  const statements = configuredAclStatementSource();
  if (!statements) return null;
  const replay = configuredIdentityReplay(identitySessionNamespace(origin));
  if (!replay) return null;
  if (process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID !== process.env.S3RCH_IDENTITY_REPLAY_TENANT_ID) {
    throw Error("Statement source and replay must use the same tenant");
  }
  const tenant = process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID;
  if (!tenant) throw Error("Squad forum tenant binding required");
  const server = createSquadForumServer(origin, statements, replay, undefined, undefined, tenant);
  cached = { identity, server };
  return server;
}

export async function squadForumReady(
  site: { source: { read(at: number, signal: AbortSignal): Promise<ForumAuthoritySnapshot> } },
  signal: AbortSignal,
  clock = () => Math.floor(Date.now() / 1000),
) {
  const authority = createForumAuthority(SEA_OWNED_FORUM_AUTHORITY, clock);
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const at = clock();
    try {
      const snapshot = await site.source.read(at, signal);
      if (!snapshot.rows.length || snapshot.completeThrough < at) return false;
      const result = await authority.refresh(snapshot, at);
      signal.throwIfAborted();
      if (roomAuthorityDiagnosticsBlock(result.diagnostics, snapshot, authority.graph)) return false;
      if (clock() === at) return result.ok;
      if (!result.ok && result.reason !== "superseded" && result.reason !== "incomplete-authority") return false;
    } catch (error) {
      if (!(error instanceof StatementSourceConflict)) throw error;
    }
    if (clock() <= at) return false;
  }
  return false;
}