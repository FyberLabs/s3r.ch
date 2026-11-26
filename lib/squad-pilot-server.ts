import { roomAuthorityDiagnosticsBlock, roomAuthorityReadDiagnosticsBlock } from "./room-authority-diagnostics";
import { configuredAclStatementSource, StatementSourceConflict } from "./acl-statement-source-server";
import type { BotStatementSource, PlaneForumUpdateAuthority } from "./forum-bot-statement-admission";
import { configuredIdentityReplay, type IdentityReplay } from "./identity/spanopticon-replay-server";
import { getIdentitySecret } from "./identity/secret";
import { parseSquadPilotConfig, type SquadPilotConfig } from "./squad-pilot-config";
import { createForumAuthority, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { createBotStatementAdmission } from "./forum-bot-statement-admission";
import { createSquadPlaneForum } from "./squad-plane-forum";
import { createSquadProjectStore } from "./squad-project";
import { createSquadBriefPublisher } from "./squad-brief";
import { createSquadWorkbookPublisher } from "./squad-workbook";
import { createSquadPreviewPublisher } from "./squad-preview";
import { createSquadProjectService } from "./squad-project-service";
import { createSpanopticonRecordStore } from "./spanopticon-record-store-server";
import { createForumAuthorityService } from "./forum-authority-service";
import { createIdentityTokenVerifier } from "./identity/sea-session-verifier";
import { readSeaSessionCookie } from "./identity/sea-session-http";
import { identitySessionNamespace } from "./identity/replay-namespace";
import type { VisorCompanionSetStore } from "./visor-companion-set-store";
import { createRoomMeetingSignaling } from "./room-meeting-signaling-server";
import { configuredVisorCompanionSetStore } from "./visor-companion-set-store";
import { createVisorCompanionSquadService } from "./visor-companion-squad-service";
export { identitySessionNamespace } from "./identity/replay-namespace";

/** Production uses only an explicitly provisioned owner source and replay store. */
export function createSquadPilotServer(c: SquadPilotConfig, statements: BotStatementSource | undefined, replay: IdentityReplay | undefined,
  clock = () => Math.floor(Date.now() / 1000),
  identitySecret = getIdentitySecret({ IDENTITY_SESSION_SECRET: process.env.IDENTITY_SESSION_SECRET, NODE_ENV: "production" }),
  planeUpdates?: PlaneForumUpdateAuthority,
  tenant = process.env.S3RCH_IDENTITY_REPLAY_TENANT_ID,
  visorStore?: VisorCompanionSetStore,
  fixtureRecord?: Readonly<{ origin?: string; apiKey?: string }>) {
  if (!statements) throw Error("ACL statement source is required");
  if (!replay) throw Error("ACL authority requires configured identity replay");
  const config = structuredClone(c);
  const source = { read: async (at: number, signal: AbortSignal) => (await statements.read(at, signal)).snapshot };
  const verifier = createIdentityTokenVerifier({ origin: config.origin, secret: identitySecret, clock });
  const authenticate = async (request: Request) => {
    const token = readSeaSessionCookie(request);
    return token ? verifier.authenticate(token) : null;
  };
  const common = { squad: config.squad, origin: config.origin, config: config.authority, clock, authenticate };
  const visorCompanion = tenant && typeof tenant === "string" && visorStore
    ? createVisorCompanionSquadService({ ...common, tenant, store: visorStore, read: source.read })
    : undefined;
  const planeForum = config.plane ? createSquadPlaneForum({ siteOrigin: config.origin,
    plane: config.plane, ...common, read: source.read }) : undefined;
  const recordKey = config.project?.recordKey ?? (config.project?.fixtureCleanup && config.origin === "https://test.s3r.ch" &&
    config.project.recordOrigin === fixtureRecord?.origin ? fixtureRecord?.apiKey : undefined);
  if (config.project && !recordKey) throw Error("Scoped Squad project record credential required");
  const projectStore = config.project && tenant && recordKey
    ? createSquadProjectStore(createSpanopticonRecordStore({
      origin: config.project.recordOrigin, apiKey: recordKey, tenant,
    }), tenant, config.squad.forumId)
    : undefined;
  const project = projectStore && config.plane && planeForum
    ? createSquadProjectService({ ...common, plane: config.plane, dispatch: planeForum, read: source.read, store: projectStore,
      fixtureCleanup: config.project?.fixtureCleanup })
    : undefined;
  const meeting = config.meetingSignaling && tenant
    ? createRoomMeetingSignaling({
      origin: config.origin,
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
          const authority = createForumAuthority(config.authority, clock);
          const verified = await authority.refresh(snapshot, at);
          signal.throwIfAborted();
          if (clock() > at) continue;
          const { graph } = authority;
          if (clock() !== at || !verified.ok || graph.ownerOf(config.squad.forumId) !== config.squad.owner ||
              roomAuthorityDiagnosticsBlock(verified.diagnostics, snapshot, graph, room)) break;
          return {
            current: () => clock() === at && !signal.aborted,
            principal(key) {
              const principal = graph.principalForKey(key, at);
              return principal && graph.writerKey(principal, at, at) === key ? principal : null;
            },
            mayJoin(principal) {
              return graph.checkForumSee(config.squad.forumId, principal, at).allowed &&
                graph.checkForumSee(room, principal, at).allowed;
            },
          };
        }
        throw Error("Meeting room authority unavailable");
      },
    })
    : undefined;
  const services = Object.freeze({ authenticate,
    ...(meeting ? { meeting } : {}),
    ...(planeForum ? { planeForum } : {}),
    ...(project ? { project } : {}),
    authority: createForumAuthorityService({ ...common, read: source.read }),
    statements: createBotStatementAdmission({ ...common, source: statements, planeUpdates,
      ...(projectStore ? { saveBrief: createSquadBriefPublisher(projectStore, clock),
        saveWorkbook: createSquadWorkbookPublisher(projectStore, clock), savePreview: createSquadPreviewPublisher(projectStore, clock) } : {}),
    }),
    rooms: createBotStatementAdmission({ ...common, source: statements, objectKind: "room" }),
    ...(visorCompanion ? { visorCompanion } : {}) });
  return { backend: "acl" as const, config, source, services, ...(visorCompanion ? { visorCompanionStore: visorStore } : {}) };
}
// No build-time or import-time secret/storage reads. The optional Vault-backed
// statement source resolves its key only when Squad calls the owner API.
let cached: { identity: string; server: ReturnType<typeof createSquadPilotServer> } | undefined;
export function getSquadPilotServer() {
  const identity = JSON.stringify([process.env.IDENTITY_SESSION_SECRET, process.env.S3RCH_SQUAD_PILOT, process.env.S3RCH_IDENTITY_REPLAY_BACKEND, process.env.S3RCH_IDENTITY_REPLAY_ORIGIN, process.env.S3RCH_IDENTITY_REPLAY_TENANT_ID, process.env.S3RCH_IDENTITY_REPLAY_API_KEY, process.env.S3RCH_AUTHORITY_BACKEND, process.env.S3RCH_STATEMENT_SOURCE_ORIGIN, process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID, process.env.S3RCH_STATEMENT_SOURCE_SCOPE, process.env.S3RCH_STATEMENT_SOURCE_API_KEY, process.env.S3RCH_STATEMENT_SOURCE_KEY_VAULT_URI, process.env.AZURE_CLIENT_ID, process.env.S3RCH_VISOR_COMPANION_RECORD_ORIGIN, process.env.S3RCH_VISOR_COMPANION_RECORD_TENANT_ID, process.env.S3RCH_VISOR_COMPANION_RECORD_API_KEY, process.env.S3RCH_SQUAD_PROJECT_RECORD_API_KEY]);
  if (cached?.identity === identity) return cached.server;
  cached = undefined;
  const config = parseSquadPilotConfig(process.env.S3RCH_SQUAD_PILOT);
  if (!config) return null;
  const replay = configuredIdentityReplay(identitySessionNamespace(config.origin));
  const statements = configuredAclStatementSource();
  if (!statements) throw Error("ACL statement source is required");
  if (process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID !== process.env.S3RCH_IDENTITY_REPLAY_TENANT_ID)
    throw Error("Statement source and replay must use the same tenant");
  if (config.plane && config.plane.tenant !== process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID) {
    throw Error("Plane and statement source must use the same tenant");
  }
  const updates = config.plane ? {
    tenant: config.plane.tenant, roster: config.plane.roster, commit: statements.commitForumUpdate,
  } : undefined;
  const tenant = process.env.S3RCH_IDENTITY_REPLAY_TENANT_ID;
  if (!tenant) throw Error("Squad pilot tenant binding required");
  const visorStore = configuredVisorCompanionSetStore(process.env, config.squad.forumId);
  const fixtureRecord = { origin: process.env.S3RCH_STATEMENT_SOURCE_ORIGIN,
    apiKey: process.env.S3RCH_SQUAD_PROJECT_RECORD_API_KEY };
  const server = createSquadPilotServer(config, statements, replay, undefined, undefined, updates, tenant, visorStore, fixtureRecord);
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
      if (roomAuthorityReadDiagnosticsBlock(result.diagnostics, snapshot)) return false;
      if (clock() === at) return result.ok && authority.graph.ownerOf(pilot.config.squad.forumId) === pilot.config.squad.owner;
      if (!result.ok && result.reason !== "superseded" && result.reason !== "incomplete-authority") return false;
    } catch (error) {
      if (!(error instanceof StatementSourceConflict)) throw error;
    }
    if (clock() <= at) return false;
  }
  return false;
}
