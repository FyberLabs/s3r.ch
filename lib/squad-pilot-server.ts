import { configuredAclStatementSource, StatementSourceConflict } from "./acl-statement-source-server";
import type { BotStatementSource } from "./forum-bot-statement-admission";
import { configuredIdentityReplay, type IdentityReplay } from "./identity/spanopticon-replay-server";
import { getIdentitySecret } from "./identity/secret";
import { parseSquadPilotConfig, type SquadPilotConfig } from "./squad-pilot-config";
import { createForumAuthority, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { createSquadHttpServices } from "./squad-http-services";
import { identitySessionNamespace } from "./identity/replay-namespace";
export { identitySessionNamespace } from "./identity/replay-namespace";

/** Production uses only an explicitly provisioned owner source and replay store. */
export function createSquadPilotServer(c: SquadPilotConfig, statements: BotStatementSource | undefined, replay: IdentityReplay | undefined,
  clock = () => Math.floor(Date.now() / 1000),
  identitySecret = getIdentitySecret({ IDENTITY_SESSION_SECRET: process.env.IDENTITY_SESSION_SECRET, NODE_ENV: "production" })) {
  if (!statements) throw Error("ACL statement source is required");
  if (!replay) throw Error("ACL authority requires configured identity replay");
  const config = structuredClone(c);
  const source = { read: async (at: number, signal: AbortSignal) => (await statements.read(at, signal)).snapshot };
  const services = createSquadHttpServices({ squad: config.squad, origin: config.origin, config: config.authority,
    secret: identitySecret, clock, consume: replay.consume, challengeDomain: replay.challengeDomain,
    statements, read: source.read });
  return { backend: "acl" as const, config, source, services };
}
// No build-time or import-time secret/storage reads. Key Vault references are
// resolved by App Service. Invalid/missing material never initializes state.
let cached: { identity: string; server: ReturnType<typeof createSquadPilotServer> } | undefined;
export function getSquadPilotServer() {
  const identity = JSON.stringify([process.env.IDENTITY_SESSION_SECRET, process.env.S3RCH_SQUAD_PILOT, process.env.S3RCH_IDENTITY_REPLAY_BACKEND, process.env.S3RCH_IDENTITY_REPLAY_ORIGIN, process.env.S3RCH_IDENTITY_REPLAY_TENANT_ID, process.env.S3RCH_IDENTITY_REPLAY_API_KEY, process.env.S3RCH_AUTHORITY_BACKEND, process.env.S3RCH_STATEMENT_SOURCE_ORIGIN, process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID, process.env.S3RCH_STATEMENT_SOURCE_SCOPE, process.env.S3RCH_STATEMENT_SOURCE_API_KEY]);
  if (cached?.identity === identity) return cached.server;
  cached = undefined;
  const config = parseSquadPilotConfig(process.env.S3RCH_SQUAD_PILOT);
  if (!config) return null;
  const replay = configuredIdentityReplay(identitySessionNamespace(config.origin));
  const statements = configuredAclStatementSource();
  if (!statements) throw Error("ACL statement source is required");
  if (process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID !== process.env.S3RCH_IDENTITY_REPLAY_TENANT_ID)
    throw Error("Statement source and replay must use the same tenant");
  const server = createSquadPilotServer(config, statements, replay);
  cached = { identity, server }; return server;
}

// Health requests arrive at arbitrary offsets within the evaluation second.
// If a read expires, discard it and verify a new primary read once.
export async function squadPilotReady(pilot: {
  config: Pick<SquadPilotConfig, "authority" | "squad">;
  source: { read(at: number, signal: AbortSignal): Promise<ForumAuthoritySnapshot> };
},
  signal: AbortSignal, clock = () => Math.floor(Date.now() / 1000)) {
  const authority = createForumAuthority(pilot.config.authority, clock);
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const at = clock();
    try {
      const snapshot = await pilot.source.read(at, signal);
      const result = await authority.refresh(snapshot, at);
      signal.throwIfAborted();
      if (result.diagnostics.length) return false;
      if (clock() === at) return result.ok && authority.graph.ownerOf(pilot.config.squad.forumId) === pilot.config.squad.owner;
      if (!result.ok && result.reason !== "superseded" && result.reason !== "incomplete-authority") return false;
    } catch (error) {
      if (!(error instanceof StatementSourceConflict)) throw error;
    }
    if (clock() <= at) return false;
  }
  return false;
}
