import { roomAuthorityDiagnosticsBlock, roomAuthorityReadDiagnosticsBlock } from "./room-authority-diagnostics";
import { configuredAclStatementSource, StatementSourceConflict } from "./acl-statement-source-server";
import type { BotStatementSource } from "./forum-bot-statement-admission";
import { configuredIdentityReplay, type IdentityReplay } from "./identity/spanopticon-replay-server";
import { getIdentitySecret } from "./identity/secret";
import { parseSiteAclConfig, type SiteAclConfig } from "./site-acl-config";
import { createForumAuthority, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { createBotStatementAdmission } from "./forum-bot-statement-admission";
import { createForumAuthorityService } from "./forum-authority-service";
import { createIdentityTokenVerifier } from "./identity/sea-session-verifier";
import { readSeaSessionCookie } from "./identity/sea-session-http";
import { identitySessionNamespace } from "./identity/replay-namespace";
import { createRoomMeetingSignaling } from "./room-meeting-signaling-server";

export function createSiteAclServer(
  config: SiteAclConfig,
  statements: BotStatementSource,
  replay: IdentityReplay | undefined,
  clock = () => Math.floor(Date.now() / 1000),
  identitySecret = getIdentitySecret({ S3RCH_SESSION_SIGNING_KEY: process.env.S3RCH_SESSION_SIGNING_KEY, NODE_ENV: "production" }),
  tenant = process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID,
) {
  if (!statements) throw Error("ACL statement source is required");
  if (!replay) throw Error("ACL authority requires configured identity replay");
  const bound = structuredClone(config);
  const source = { read: async (at: number, signal: AbortSignal) => (await statements.read(at, signal)).snapshot };
  const verifier = createIdentityTokenVerifier({ origin: bound.origin, secret: identitySecret, clock });
  const authenticate = async (request: Request) => {
    const token = readSeaSessionCookie(request);
    return token ? verifier.authenticate(token) : null;
  };
  const common = { origin: bound.origin, config: bound.authority, clock, authenticate };
  const meeting = tenant
    ? createRoomMeetingSignaling({
      origin: bound.origin,
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
          const authority = createForumAuthority(bound.authority, clock);
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
  return { backend: "acl" as const, config: bound, source, services, ...(meeting ? { meeting } : {}) };
}

let cached: { identity: string; server: ReturnType<typeof createSiteAclServer> } | undefined;

export function getSiteAclServer() {
  const identity = JSON.stringify([
    process.env.S3RCH_SESSION_SIGNING_KEY, process.env.S3RCH_SITE_ORIGIN, process.env.S3RCH_FORUM_AUTHORITY,
    process.env.S3RCH_IDENTITY_REPLAY_BACKEND, process.env.S3RCH_IDENTITY_REPLAY_ORIGIN,
    process.env.S3RCH_IDENTITY_REPLAY_TENANT_ID, process.env.S3RCH_SERVICE_CREDENTIAL,
    process.env.S3RCH_AUTHORITY_BACKEND, process.env.S3RCH_STATEMENT_SOURCE_ORIGIN,
    process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID, process.env.S3RCH_STATEMENT_SOURCE_SCOPE,
    process.env.S3RCH_STATEMENT_SOURCE_KEY_VAULT_URI, process.env.AZURE_CLIENT_ID,
  ]);
  if (cached?.identity === identity) return cached.server;
  cached = undefined;
  const config = parseSiteAclConfig(process.env);
  if (!config) return null;
  const replay = configuredIdentityReplay(identitySessionNamespace(config.origin));
  const statements = configuredAclStatementSource();
  if (!statements) throw Error("ACL statement source is required");
  if (process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID !== process.env.S3RCH_IDENTITY_REPLAY_TENANT_ID) {
    throw Error("Statement source and replay must use the same tenant");
  }
  const tenant = process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID;
  if (!tenant) throw Error("Site ACL tenant binding required");
  const server = createSiteAclServer(config, statements, replay!, undefined, undefined, tenant);
  cached = { identity, server };
  return server;
}

export async function siteAclReady(
  site: { config: Pick<SiteAclConfig, "authority">; source: { read(at: number, signal: AbortSignal): Promise<ForumAuthoritySnapshot> } },
  signal: AbortSignal,
  clock = () => Math.floor(Date.now() / 1000),
) {
  const authority = createForumAuthority(site.config.authority, clock);
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