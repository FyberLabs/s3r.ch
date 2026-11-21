import { shortSea } from "./forum-squad";
import { roomAuthorityReadDiagnosticsBlock } from "./room-authority-diagnostics";
import { createForumAuthority, type ForumAuthorityConfig, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { isSeaPubkey } from "./identity/forum-check";
import type { LiveSquadSpec } from "./squad-view";
import { RecordConflict } from "./record-store";
import type { VisorCompanionSetSnapshot, VisorCompanionSetStore } from "./visor-companion-set-store";

export type { VisorCompanionSetSnapshot, VisorCompanionSetStore } from "./visor-companion-set-store";
export const VISOR_COMPANION_AGENT_SCOPE = "squad:visor-companion:resolve";
export const VISOR_COMPANION_EVALUATED_AT_SKEW_SECONDS = 60;

export type VisorCompanionMemberRole = "companion" | "external";

export type VisorCompanionResolveRequest = Readonly<{
  version: 1;
  evaluatedAt: number;
  tenant: string;
  machineId: string;
  setId: string;
  setGeneration: string;
  members: readonly VisorCompanionMemberRequest[];
}>;

export type VisorCompanionMemberRequest = Readonly<{
  role: VisorCompanionMemberRole;
  principal: string;
  companion?: string;
  session?: string;
  generation?: string;
}>;

export type VisorCompanionRosterRow = Readonly<{
  principal: string;
  role: VisorCompanionMemberRole;
  label: string;
}>;

export type VisorCompanionResolveResponse = Readonly<{
  version: 1;
  evaluatedAt: number;
  forumId: string;
  owner: string;
  label: string;
  destination: string;
  setId: string;
  setGeneration: string;
  roster: readonly VisorCompanionRosterRow[];
}>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RETIRED_COMPANIONS = 8;
const sortedFieldNames = (row: Record<string, unknown>) => Object.keys(row).sort((a, b) => a.localeCompare(b));

function uuidField(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}

function memberRequest(value: unknown): VisorCompanionMemberRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.role !== "companion" && row.role !== "external") return null;
  if (typeof row.principal !== "string" || !isSeaPubkey(row.principal)) return null;
  if (row.role === "companion") {
    if (!uuidField(row.companion) || !uuidField(row.session) || !uuidField(row.generation)) return null;
    const keys = sortedFieldNames(row as Record<string, unknown>).join();
    if (keys !== "companion,generation,principal,role,session") return null;
    return Object.freeze({ role: "companion", principal: row.principal, companion: row.companion, session: row.session, generation: row.generation });
  }
  if (sortedFieldNames(row as Record<string, unknown>).join() !== "principal,role") return null;
  return Object.freeze({ role: "external", principal: row.principal });
}

/** Request fields only; owner and tenant are checked against authenticated scope. */
export function parseVisorCompanionResolveRequest(body: unknown): VisorCompanionResolveRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const row = body as Record<string, unknown>;
  if (row.version !== 1 || !Number.isSafeInteger(row.evaluatedAt) || (row.evaluatedAt as number) < 0) return null;
  if (!uuidField(row.tenant) || !uuidField(row.machineId) || !uuidField(row.setId) || !uuidField(row.setGeneration)) return null;
  if (!Array.isArray(row.members) || row.members.length > 8) return null;
  const members = row.members.map(memberRequest);
  if (members.some(member => !member)) return null;
  const companionIds = new Set<string>(), principals = new Set<string>();
  for (const member of members) {
    if (member!.role === "companion") {
      if (companionIds.has(member!.companion!)) return null;
      companionIds.add(member!.companion!);
    }
    if (principals.has(member!.principal)) return null;
    principals.add(member!.principal);
  }
  if (sortedFieldNames(row as Record<string, unknown>).join() !== "evaluatedAt,machineId,members,setGeneration,setId,tenant,version") return null;
  return Object.freeze({
    version: 1,
    evaluatedAt: row.evaluatedAt as number,
    tenant: row.tenant,
    machineId: row.machineId,
    setId: row.setId,
    setGeneration: row.setGeneration,
    members: Object.freeze(members as VisorCompanionMemberRequest[]),
  });
}

export function squadForumDestination(origin: string): string {
  const url = new URL("/feed/squad/live", origin);
  if (url.origin !== origin || url.protocol !== "https:" || url.search || url.hash || url.username || url.password) throw Error("Canonical squad destination required");
  return url.href;
}

export function visorCompanionEvaluatedAtWithinSkew(clientAt: number, serverAt: number): boolean {
  if (!Number.isSafeInteger(clientAt) || !Number.isSafeInteger(serverAt) || clientAt < 0 || serverAt < 0) return false;
  return Math.abs(clientAt - serverAt) <= VISOR_COMPANION_EVALUATED_AT_SKEW_SECONDS;
}

function companionSnapshot(request: VisorCompanionResolveRequest, stored: VisorCompanionSetSnapshot | null): VisorCompanionSetSnapshot {
  const companions = new Map<string, Readonly<{ session: string; generation: string; principal: string }>>();
  for (const member of request.members) {
    if (member.role !== "companion") continue;
    companions.set(member.companion!, Object.freeze({ session: member.session!, generation: member.generation!, principal: member.principal }));
  }
  const retired = new Map<string, Readonly<{ session: string; generation: string; principal: string }>>();
  if (stored && stored.setId === request.setId) {
    for (const [id, row] of stored.retired) retired.set(id, row);
    if (stored.setGeneration === request.setGeneration) {
      for (const [id, row] of stored.companions) if (!companions.has(id)) retired.set(id, row);
    } else for (const [id, row] of stored.companions) retired.set(id, row);
  }
  if (retired.size > MAX_RETIRED_COMPANIONS) throw new Error("Visor companion set capacity");
  return Object.freeze({ setId: request.setId, setGeneration: request.setGeneration, companions, retired });
}

function staleCompanion(
  stored: VisorCompanionSetSnapshot | null,
  request: VisorCompanionResolveRequest,
): boolean {
  if (!stored || stored.setId !== request.setId) return false;
  if (stored.setGeneration === request.setGeneration) return false;
  for (const member of request.members) {
    if (member.role !== "companion") continue;
    const prev = stored.companions.get(member.companion!);
    if (prev && prev.generation === member.generation) return true;
    const retired = stored.retired.get(member.companion!);
    if (retired && retired.generation === member.generation) return true;
  }
  return false;
}

export type VisorCompanionResolveInput = Readonly<{
  squad: LiveSquadSpec;
  origin: string;
  authority: ForumAuthorityConfig;
  tenant: string;
  ownerPrincipal: string;
  evaluatedAt: number;
  request: VisorCompanionResolveRequest;
  snapshot: ForumAuthoritySnapshot;
  store: VisorCompanionSetStore;
  clock?: () => number;
}>;

export type VisorCompanionResolveResult =
  | { ok: true; body: VisorCompanionResolveResponse }
  | { ok: false; reason: "scope-or-time" | "stale-generation" | "authority" | "tenant" | "owner" };

/** Map the current companion set to an authority-checked roster and browser destination. */
export async function resolveVisorCompanionSquad(input: VisorCompanionResolveInput): Promise<VisorCompanionResolveResult> {
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const at = input.evaluatedAt;
  if (!visorCompanionEvaluatedAtWithinSkew(input.request.evaluatedAt, at)) return { ok: false, reason: "scope-or-time" };
  if (input.request.tenant !== input.tenant) return { ok: false, reason: "tenant" };
  if (input.ownerPrincipal !== input.squad.owner) return { ok: false, reason: "owner" };
  const held = await input.store.read(input.request.tenant, input.squad.owner, input.request.machineId);
  const stored = held.snapshot;
  if (staleCompanion(stored, input.request)) return { ok: false, reason: "stale-generation" };
  const authority = createForumAuthority(input.authority, clock);
  const verified = await authority.refresh(structuredClone(input.snapshot), at);
  if (!verified.ok || roomAuthorityReadDiagnosticsBlock(verified.diagnostics, input.snapshot) ||
      authority.graph.ownerOf(input.squad.forumId) !== input.squad.owner) return { ok: false, reason: "authority" };
  const roster: VisorCompanionRosterRow[] = [];
  for (const member of input.request.members) {
    if (!authority.graph.checkForumSee(input.squad.forumId, member.principal, at).allowed) continue;
    roster.push(Object.freeze({ principal: member.principal, role: member.role, label: shortSea(member.principal) }));
  }
  roster.sort((a, b) => a.principal.localeCompare(b.principal));
  if (stored?.setId === input.request.setId && stored.setGeneration === input.request.setGeneration) {
    for (const member of input.request.members) {
      if (member.role !== "companion") continue;
      const prev = stored.companions.get(member.companion!);
      if (prev && prev.generation !== member.generation) return { ok: false, reason: "stale-generation" };
    }
  }
  try {
    await input.store.write(input.request.tenant, input.squad.owner, input.request.machineId,
      companionSnapshot(input.request, stored), held.revision);
  } catch (error) {
    if (error instanceof RecordConflict) return { ok: false, reason: "stale-generation" };
    if (error instanceof Error && error.message === "Visor companion set capacity") {
      return { ok: false, reason: "stale-generation" };
    }
    throw error;
  }
  return {
    ok: true,
    body: Object.freeze({
      version: 1,
      evaluatedAt: at,
      forumId: input.squad.forumId,
      owner: input.squad.owner,
      label: input.squad.label,
      destination: squadForumDestination(input.origin),
      setId: input.request.setId,
      setGeneration: input.request.setGeneration,
      roster: Object.freeze(roster),
    }),
  };
}