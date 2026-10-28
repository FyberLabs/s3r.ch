/**
 * Squad forum view model. Souls and Check stay in `lib/identity/check.ts`.
 * Chat items are tagged `s3rch/items`. Role tokens are not predicates.
 */

import {
  GUN_PROTOCOL_V,
  fromGunNode,
  type FeedItem,
} from "@/lib/feed-types";
import { soulKeyMatches } from "@/lib/unshare";
import {
  forumAgentSoul,
  forumChatTag,
  forumChatTagPresent,
  forumChatTags,
  forumNeedSoul,
  forumOfferSoul,
  forumStatementSoul,
  isForumChatExtraTag,
  checkSee,
  embeddedPrincipalKey,
  isForumObjectId,
  isRoleToken,
  isSeaPubkey,
  sameEmbeddedPrincipal,
  seaFromPrincipalKey,
  seaToPrincipalKey,
  validateForumNeed,
  validateForumOffer,
  validateForumStatus,
  type ForumAgentState,
  type ForumAgentStatus,
  type ForumAlarm,
  type ForumNeed,
  type ForumOffer,
  type ForumRoleMembership,
  type SeeGraph,
} from "@/lib/identity/check";

export type SquadSubtaskState = "done" | "running" | "failed" | "pending";

export type SquadSubtask = {
  id: string;
  label: string;
  state: SquadSubtaskState;
};

export type SquadUpdate = {
  id: string;
  ts: number;
  body: string;
};

export type SquadAgent = {
  label: string;
  promptBy: string;
  artifactNote: string;
  status: ForumAgentStatus;
  subtasks: SquadSubtask[];
  updates: SquadUpdate[];
};

export type VitalsMode = "auto" | "dot" | "full";

const RANK: Record<ForumAgentState, number> = {
  emergency: 0,
  needs: 1,
  working: 2,
  idle: 3,
};

export function severityRank(state: ForumAgentState): number {
  return RANK[state];
}

export function sortAgents(agents: readonly SquadAgent[]): SquadAgent[] {
  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => {
      const rank = severityRank(a.agent.status.state) - severityRank(b.agent.status.state);
      return rank === 0 ? a.index - b.index : rank;
    })
    .map((row) => row.agent);
}

export function filterAgents(
  agents: readonly SquadAgent[],
  states: ReadonlySet<ForumAgentState>,
  query: string,
): SquadAgent[] {
  const needle = query.trim().toLowerCase();
  const filtered = agents.filter((agent) => {
    if (states.size > 0 && !states.has(agent.status.state)) return false;
    if (!needle) return true;
    const hay = [
      agent.label,
      agent.status.task,
      agent.status.result,
      agent.status.lastPrompt,
      agent.status.type,
    ]
      .join("\n")
      .toLowerCase();
    return hay.includes(needle);
  });
  return sortAgents(filtered);
}

export function showFullVitals(type: string, mode: VitalsMode): boolean {
  if (mode === "dot") return false;
  if (mode === "full") return true;
  return type === "robot" || type === "robotics";
}

export function chatTone(item: { kind: string; tags: readonly string[]; body: string }):
  | "emergency"
  | "system"
  | "statement" {
  if (item.kind === "notice" || item.tags.includes("notice")) return "system";
  if (item.tags.includes("emergency") || item.body.includes("EMERGENCY:")) return "emergency";
  return "statement";
}

/** Display tokens after `@`. Addressing only. Not principals and not grants. */
export function chatAddresses(body: string): string[] {
  const out: string[] = [];
  const re = /(^|[^\w])@([A-Za-z][A-Za-z0-9-]{0,31})/g;
  for (const match of body.matchAll(re)) {
    if (match[2]) out.push(match[2]);
  }
  return out;
}

export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "—";
  if (tokens >= 1000) {
    const scaled = tokens / 1000;
    const text = scaled >= 10 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, "");
    return `${text}k`;
  }
  return String(Math.round(tokens));
}

export function formatRuntime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

export function formatClock(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const date = new Date(ts * 1000);
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function shortSea(pub: string): string {
  if (pub.length < 12) return pub;
  return `${pub.slice(0, 4)}…${pub.slice(-4)}`;
}

export function needIds(needs: string): string[] {
  if (!needs) return [];
  return needs.split(",").filter((id) => isForumObjectId(id, "need"));
}

export function openNeedFor(
  status: ForumAgentStatus,
  needs: ReadonlyMap<string, ForumNeed>,
): ForumNeed | null {
  for (const id of needIds(status.needs)) {
    const need = needs.get(id);
    if (need && need.stated === 1) return need;
  }
  return null;
}

/**
 * Status field writes on this app are an owner put. Check see is the
 * resolve gate, not this one. A wallet is not an owner here.
 */
export function canWriteStatus(owner: string | undefined, writer: string | null): boolean {
  return !!owner && !!writer && owner === writer && isSeaPubkey(writer);
}

/** Pause and reassign follow the forum owner, not whoever the status id names. */
export function forumOwnerMayWriteStatus(forumOwner: string | undefined, writer: string | null): boolean {
  return canWriteStatus(forumOwner, writer);
}

export function pausedStatus(status: ForumAgentStatus, now: number): ForumAgentStatus {
  return { ...status, state: "idle", lastUpdate: now };
}

export function reassignedStatus(
  status: ForumAgentStatus,
  target: string,
  now: number,
): ForumAgentStatus | null {
  if (!isSeaPubkey(target)) return null;
  return { ...status, lastUpdate: now, result: `reassign ${target}` };
}

export function buildForumStatement(input: {
  forumId: string;
  author: string;
  body: string;
  now: number;
  entropy: string;
  extras?: readonly string[];
}): FeedItem | null {
  const body = input.body.trim();
  if (!body || body.length > 280) return null;
  if (!isSeaPubkey(input.author)) return null;
  const entropy = input.entropy.trim().toLowerCase();
  const authorKey = seaToPrincipalKey(input.author);
  if (!authorKey || !/^[0-9a-f]{32}$/.test(entropy)) return null;
  const tags = forumChatTags(input.forumId, input.extras ?? []);
  if (!tags) return null;
  const id = `stmt_${authorKey}_${entropy}`;
  if (!sameEmbeddedPrincipal(input.author, id)) return null;
  const ts = Math.floor(input.now);
  try {
    forumStatementSoul(id);
  } catch {
    return null;
  }
  return {
    id,
    source: "s3rch",
    kind: "statement",
    author: input.author,
    body,
    ts,
    permalink: "",
    tags,
    provenance: "s3rch:forum-statement",
    v: GUN_PROTOCOL_V,
  };
}

export function forumStatementFromNode(node: unknown, forumId: string): FeedItem | null {
  if (!node || typeof node !== "object") return null;
  const rawTags = (node as { tags?: unknown }).tags;
  if (typeof rawTags !== "string") return null;
  if (!forumChatTagPresent(rawTags, forumId)) return null;
  let required: string;
  try {
    required = forumChatTag(forumId);
  } catch {
    return null;
  }
  const parts = rawTags.split(",");
  for (const part of parts) {
    if (part === required) continue;
    if (!isForumChatExtraTag(part)) return null;
  }
  const item = fromGunNode(node as Parameters<typeof fromGunNode>[0]);
  if (!item || !isSeaPubkey(item.author)) return null;
  return { ...item, tags: parts };
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseForumAgentStatus(value: unknown): ForumAgentStatus | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const state = text(row.state);
  if (state !== "idle" && state !== "working" && state !== "needs" && state !== "emergency") {
    return null;
  }
  const id = text(row.id);
  const forumId = text(row.forumId);
  const seaPubkey = text(row.seaPubkey);
  const task = text(row.task);
  const result = text(row.result);
  const needs = text(row.needs);
  const lastPrompt = text(row.lastPrompt);
  const type = text(row.type);
  const progress = num(row.progress);
  const lastUpdate = num(row.lastUpdate);
  const started = num(row.started);
  const tokens = num(row.tokens);
  const runtime = num(row.runtime);
  if (
    !id ||
    !forumId ||
    !seaPubkey ||
    task === null ||
    result === null ||
    needs === null ||
    lastPrompt === null ||
    !type ||
    progress === null ||
    lastUpdate === null ||
    started === null ||
    tokens === null ||
    runtime === null
  ) {
    return null;
  }
  const status: ForumAgentStatus = {
    id,
    forumId,
    seaPubkey,
    task,
    result,
    needs,
    progress,
    state,
    lastPrompt,
    lastUpdate,
    type,
    started,
    tokens,
    runtime,
  };
  if ("hb" in row && row.hb !== undefined && row.hb !== null) {
    const hb = num(row.hb);
    if (hb === null) return null;
    status.hb = hb;
  }
  if ("batt" in row && row.batt !== undefined && row.batt !== null) {
    const batt = num(row.batt);
    if (batt === null) return null;
    status.batt = batt;
  }
  if ("link" in row && row.link !== undefined && row.link !== null) {
    const link = num(row.link);
    if (link === null) return null;
    status.link = link;
  }
  if ("artifacts" in row && row.artifacts !== undefined && row.artifacts !== null) {
    const artifacts = text(row.artifacts);
    if (artifacts === null) return null;
    status.artifacts = artifacts;
  }
  return validateForumStatus(status) ? status : null;
}

export function parseForumNeed(value: unknown): ForumNeed | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id);
  const forumId = text(row.forumId) ?? text(row.forum_id);
  const subject = text(row.subject);
  const severity = text(row.severity);
  const body = text(row.body);
  const stated = num(row.stated);
  const hamState = num(row.hamState);
  const ts = num(row.ts);
  if (!id || !forumId || !subject || !body || stated === null || hamState === null || ts === null) {
    return null;
  }
  if (severity !== "need" && severity !== "emergency") return null;
  if (stated !== 0 && stated !== 1) return null;
  const need: ForumNeed = {
    id,
    forumId,
    subject,
    severity,
    body,
    stated,
    hamState,
    ts,
  };
  const spec = text(row.spec);
  if (spec) need.spec = spec;
  const accepted = text(row.acceptedOffer) ?? text(row.accepted_offer);
  if (accepted !== null) need.acceptedOffer = accepted;
  return validateForumNeed(need) ? need : null;
}

export function parseForumOffer(value: unknown): ForumOffer | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id);
  const need = text(row.need);
  const forumId = text(row.forumId) ?? text(row.forum_id);
  const helper = text(row.helper);
  const body = text(row.body);
  const stated = num(row.stated);
  if (!id || !need || !forumId || !helper || body === null || stated === null) return null;
  if (stated !== 0 && stated !== 1) return null;
  const artifacts = text(row.artifacts) ?? "";
  const offer: ForumOffer = { id, need, forumId, helper, body, artifacts, stated };
  return validateForumOffer(offer) ? offer : null;
}

/**
 * An admitted sample owner stays the owner. A mesh edge does not replace
 * that owner. An unsigned mesh grant is not Check see on a sample object:
 * the owner string is not a signature. Objects the sample does not admit
 * still read the user graph.
 */
export function overlaySeeGraph(primary: SeeGraph, sample: SeeGraph): SeeGraph {
  return {
    hasObject(object) {
      return sample.hasObject(object) || primary.hasObject(object);
    },
    ownerOf(object) {
      return sample.ownerOf(object) ?? primary.ownerOf(object);
    },
    seeGrants(object) {
      if (sample.ownerOf(object)) return sample.seeGrants(object);
      return primary.seeGrants(object);
    },
  };
}

/**
 * A local pause or reassign wins only while it is strictly newer than the
 * mesh row. An equal or later mesh `lastUpdate` retires the override.
 */
export function pickDisplayedStatus(
  base: ForumAgentStatus,
  local: ForumAgentStatus | undefined,
): ForumAgentStatus {
  if (!local) return base;
  if (local.lastUpdate > base.lastUpdate) return local;
  return base;
}

/**
 * Per map-key generation for mesh callbacks. A later event on the same key
 * makes an in-flight signature read stale.
 */
export function createMeshEventVersions(): {
  bump: (scope: string, key: string) => number;
  current: (scope: string, key: string, generation: number) => boolean;
} {
  const versions = new Map<string, number>();
  function id(scope: string, key: string): string {
    return `${scope}\n${key}`;
  }
  return {
    bump(scope, key) {
      const next = (versions.get(id(scope, key)) ?? 0) + 1;
      versions.set(id(scope, key), next);
      return next;
    },
    current(scope, key, generation) {
      return versions.get(id(scope, key)) === generation;
    },
  };
}

/**
 * Hide target for a verified chat tombstone. Unsigned `null`, a missing
 * signature, a tag strip, and a payload id on a different Gun key are not
 * hide targets. The tombstone must name this forum and soul-match the map key.
 */
export function chatRetractionIds(
  data: unknown,
  key: string | undefined,
  knownIds: readonly string[],
  forumId: string,
): string[] {
  if (!data || typeof data !== "object") return [];
  const row = data as Record<string, unknown>;
  if (row.unshared !== 1 || row.forumId !== forumId) return [];
  if (typeof row.id !== "string") return [];
  const mapKey = typeof key === "string" ? key.trim() : "";
  if (!mapKey || !soulKeyMatches(row.id, mapKey)) return [];
  const named = isForumObjectId(row.id, "stmt") && embeddedPrincipalKey(row.id) !== null;
  if (!named && !knownIds.some((known) => soulKeyMatches(known, mapKey))) return [];
  return [mapKey];
}

/** Author pubkey embedded in a `stmt_` id. A legacy id has none. */
export function chatAuthorFromStatementId(id: string): string | null {
  if (!isForumObjectId(id, "stmt")) return null;
  const embedded = embeddedPrincipalKey(id);
  if (!embedded) return null;
  const pub = seaFromPrincipalKey(embedded);
  if (!pub || !sameEmbeddedPrincipal(pub, id)) return null;
  return pub;
}

/** Author or forum owner. A stranger's signature does not hide the line. */
export function authorizeForumChatTombstone(input: {
  signer: string;
  author: string | undefined;
  owner: string | undefined;
}): boolean {
  if (!isSeaPubkey(input.signer)) return false;
  if (input.author && input.signer === input.author && isSeaPubkey(input.author)) return true;
  return !!input.owner && input.signer === input.owner && isSeaPubkey(input.owner);
}

export function withoutChatIds(items: readonly FeedItem[], ids: readonly string[]): FeedItem[] {
  if (ids.length === 0) return [...items];
  return items.filter((item) => !ids.some((id) => soulKeyMatches(item.id, id)));
}

export type ForumAgentRemoval = {
  removed: 1;
  action: "remove";
  forumId: string;
  seaPubkey: string;
  id: string;
};

/** Signed removal. Unsigned `null` is not a removal. `action` binds the tombstone. */
export function parseForumAgentRemoval(value: unknown): ForumAgentRemoval | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.removed !== 1 || row.action !== "remove") return null;
  if (typeof row.forumId !== "string" || typeof row.seaPubkey !== "string" || typeof row.id !== "string") {
    return null;
  }
  if (!isForumObjectId(row.forumId, "forum") || !isForumObjectId(row.id, "status")) return null;
  if (!isSeaPubkey(row.seaPubkey) || !sameEmbeddedPrincipal(row.seaPubkey, row.id)) return null;
  return { removed: 1, action: "remove", forumId: row.forumId, seaPubkey: row.seaPubkey, id: row.id };
}

function ownerMayWrite(signer: string, owner: string | undefined): boolean {
  return !!owner && signer === owner && canWriteStatus(owner, signer);
}

/**
 * The forum owner admits a pubkey. Owning `status.id` does not: an unsigned
 * ACL edge can name that owner. `enrolled` is a self-update of a pubkey
 * already on the roster. `pending` waits for forum-owner admission.
 * `denied` is ignored. The map key is the agent pubkey on the signed row.
 */
export function forumStatusAdmission(input: {
  status: ForumAgentStatus;
  mapKey: string;
  signer: string;
  forumOwner?: string;
  forumId: string;
  enrolled: boolean;
}): "owner" | "enrolled" | "pending" | "denied" {
  if (input.mapKey !== input.status.seaPubkey) return "denied";
  if (input.status.forumId !== input.forumId) return "denied";
  if (!isSeaPubkey(input.signer)) return "denied";
  if (ownerMayWrite(input.signer, input.forumOwner)) return "owner";
  if (input.signer === input.status.seaPubkey) return input.enrolled ? "enrolled" : "pending";
  return "denied";
}

/**
 * Mesh status may replace a roster tile only when the signature signer is
 * the agent pubkey already on the roster, or the admitted owner, and the
 * Gun map key is that agent. A self-signature does not enroll a new key.
 */
export function authorizeForumStatus(input: {
  status: ForumAgentStatus;
  mapKey: string;
  signer: string;
  forumOwner?: string;
  forumId: string;
  enrolled: boolean;
}): boolean {
  const admission = forumStatusAdmission(input);
  return admission === "owner" || admission === "enrolled";
}

/**
 * Agent or forum owner. The map key is the agent pubkey.
 * Owning the status id does not sign this removal. Unsigned null is not this.
 */
export function authorizeForumAgentRemoval(input: {
  removal: ForumAgentRemoval;
  mapKey: string;
  signer: string;
  forumOwner: string | undefined;
  forumId: string;
}): boolean {
  const removal = input.removal;
  if (removal.removed !== 1 || removal.action !== "remove" || removal.forumId !== input.forumId) return false;
  if (input.mapKey !== removal.seaPubkey) return false;
  if (!isSeaPubkey(input.signer) || !sameEmbeddedPrincipal(removal.seaPubkey, removal.id)) return false;
  if (input.signer === removal.seaPubkey) return true;
  return ownerMayWrite(input.signer, input.forumOwner);
}

export function parseForumRoleMembership(value: unknown): ForumRoleMembership | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.forumId !== "string" || typeof row.role !== "string" || typeof row.principal !== "string") {
    return null;
  }
  if (!isForumObjectId(row.forumId, "forum") || !isRoleToken(row.role) || !isSeaPubkey(row.principal)) {
    return null;
  }
  return { forumId: row.forumId, role: row.role, principal: row.principal };
}

/** Forum owner signs the membership. The map key is the principal. Self-sign does not admit. */
export function authorizeForumRoleAdmission(input: {
  membership: ForumRoleMembership;
  roleToken: string;
  mapKey: string;
  signer: string;
  forumOwner: string | undefined;
  forumId: string;
}): boolean {
  const membership = input.membership;
  if (membership.forumId !== input.forumId || membership.role !== input.roleToken) return false;
  if (input.mapKey !== membership.principal || !isRoleToken(input.roleToken)) return false;
  return ownerMayWrite(input.signer, input.forumOwner);
}

/**
 * Chat mesh rows are signed by the statement author. The tag does not grant.
 * A later put of an existing id must be that same author. The forum owner
 * may hide a line with a tombstone, and may not replace its body.
 */
export function authorizeForumChat(
  item: FeedItem,
  signer: string,
  mapKey: string | undefined,
  forumId: string,
  priorAuthor?: string,
): boolean {
  if (signer !== item.author || !isSeaPubkey(signer)) return false;
  if (!sameEmbeddedPrincipal(signer, item.id)) return false;
  if (priorAuthor && priorAuthor !== item.author) return false;
  if (!item.tags.includes(forumChatTag(forumId))) return false;
  if (mapKey !== undefined && !soulKeyMatches(item.id, mapKey)) return false;
  return true;
}

export type ForumNeedClosure = {
  graph: SeeGraph;
  postedOffers: ReadonlyMap<string, ForumOffer>;
  now: number;
};

/**
 * A close (`stated` 0 with an accepted offer) uses the same live-offer and
 * helper Check see gates as accept. The admitted owner may sign any other
 * need row. Accept does not elect.
 */
export function authorizeForumNeed(
  need: ForumNeed,
  signer: string,
  owner: string | undefined,
  forumId: string,
  known?: ForumNeed,
  closure?: ForumNeedClosure,
): boolean {
  if (need.forumId !== forumId || !isSeaPubkey(signer)) return false;
  if (known && known.stated === 1 && need.stated === 0 && need.id === known.id) {
    const party = signer === owner || (signer === known.subject && signer === need.subject);
    if (!party) return false;
    if (need.hamState <= known.hamState) return false;
    if (need.body !== known.body || need.severity !== known.severity) return false;
    if ((need.spec ?? "") !== (known.spec ?? "")) return false;
    if (!need.acceptedOffer || !closure) return false;
    return needClosureStatus(need, closure) === "ok";
  }
  if (!known && need.stated === 0 && need.acceptedOffer && signer === need.subject) {
    if (!closure) return false;
    return needClosureStatus(need, closure) === "ok";
  }
  return !!owner && signer === owner;
}

/** Live posted offer and helper Check see. `wait` means the offer or grant is not loaded yet. */
export function needClosureStatus(
  need: ForumNeed,
  closure: ForumNeedClosure,
): "ok" | "wait" | "denied" {
  const offerId = need.acceptedOffer;
  if (!offerId) return "denied";
  const posted = closure.postedOffers.get(offerId);
  if (!posted) return "wait";
  if (!validateForumOffer(posted) || posted.stated !== 1) return "denied";
  if (posted.need !== need.id || posted.forumId !== need.forumId) return "denied";
  if (!closure.graph.hasObject(need.id)) return "wait";
  const see = checkSee(closure.graph, need.id, posted.helper, closure.now);
  if (see.allowed) return "ok";
  if (see.reason === "missing-grant" || see.reason === "missing-object") return "wait";
  return "denied";
}

/** The alarm pin is signed by the admitted owner of the forum id. */
export function authorizeForumAlarm(
  alarm: ForumAlarm,
  signer: string,
  forumOwner: string | undefined,
  forumId: string,
): boolean {
  return alarm.forumId === forumId && !!forumOwner && signer === forumOwner && isSeaPubkey(signer);
}

/**
 * The helper signs a withdrawal. A live post also requires Check see on the
 * parent need, the same gate as offering help. The need owner or subject may
 * sign a cancel (`stated` 0). A live row is not signed by a third party.
 */
export function authorizeForumOffer(
  offer: ForumOffer,
  signer: string,
  forumId: string,
  party?: { owner?: string; subject?: string },
  seen?: { graph: SeeGraph; need: ForumNeed; now: number },
): boolean {
  if (offer.forumId !== forumId || !isSeaPubkey(signer)) return false;
  if (signer === offer.helper) {
    if (offer.stated === 0) {
      if (seen?.need.stated === 0 && seen.need.acceptedOffer === offer.id) return false;
      return true;
    }
    if (!seen || seen.need.id !== offer.need || seen.need.forumId !== offer.forumId) return false;
    if (!seen.graph.hasObject(seen.need.id)) return false;
    return checkSee(seen.graph, seen.need.id, signer, seen.now).allowed;
  }
  if (offer.stated !== 0) return false;
  return signer === party?.owner || signer === party?.subject;
}

/**
 * A live offer waits when the parent need is not in the graph yet, or Check
 * has no grant row yet. A hard deny is not a wait.
 */
export function offerSeeWait(input: {
  offer: ForumOffer;
  graph: SeeGraph | null;
  need?: ForumNeed;
  now: number;
}): boolean {
  if (input.offer.stated !== 1) return false;
  if (!input.graph || !input.need) return true;
  if (input.need.id !== input.offer.need || input.need.forumId !== input.offer.forumId) return false;
  if (!input.graph.hasObject(input.need.id)) return true;
  const see = checkSee(input.graph, input.need.id, input.offer.helper, input.now);
  return !see.allowed && (see.reason === "missing-grant" || see.reason === "missing-object");
}

/**
 * An owner or subject cancel cannot be verified until that need and its
 * owner are loaded. A failed check before then waits. Gun does not deliver
 * the row again.
 */
export function offerCancelAwaitingKeys(input: {
  graph: SeeGraph | null;
  need?: ForumNeed;
  needId: string;
}): boolean {
  if (!input.graph || !input.need || input.need.id !== input.needId) return true;
  const owner = input.graph.ownerOf(input.needId);
  if (!owner || !isSeaPubkey(owner)) return true;
  if (!input.need.subject || !isSeaPubkey(input.need.subject)) return true;
  return false;
}

/**
 * Signed cancel soul for an offer. Same offer record, `stated` 0.
 * A replay at the offer soul does not remove this node.
 */
export function forumOfferCancelSoul(forumId: string, needId: string, offerId: string): string {
  return `${forumOfferSoul(forumId, needId, offerId)}/cancel`;
}

/** Signed removal child. A replay at the live key does not erase this node. */
export function forumStatusRemovalSoul(forumId: string, seaPubkey: string): string {
  return `${forumAgentSoul(forumId, seaPubkey)}/remove`;
}

export function forumNeedRemovalSoul(forumId: string, needId: string): string {
  return `${forumNeedSoul(forumId, needId)}/remove`;
}

export function forumOfferRemovalSoul(forumId: string, needId: string, offerId: string): string {
  return `${forumOfferSoul(forumId, needId, offerId)}/remove`;
}

export function forumChatRemovalSoul(itemId: string): string {
  return `${forumStatementSoul(itemId)}/remove`;
}

/**
 * A verified removal sticks against an older live copy. A missing stamp
 * blocks every finite replay. A newer stamp may pass.
 */
export function liveReplayBlocked(liveStamp: number, tombstoneStamp: number | undefined): boolean {
  return tombstoneStamp !== undefined && !(liveStamp > tombstoneStamp);
}

/**
 * Offer removal uses the subscribed parent need. An unsigned `need` hint
 * that names another need is refused, and so is a payload whose need does
 * not match that parent.
 */
export function offerRemovalAuthority(input: {
  parentNeedId: string;
  hintedNeed?: string;
  removalNeed: string;
  parent?: ForumNeed;
  offerId: string;
}): { subject: string | undefined; resolved: boolean } | null {
  if (input.hintedNeed !== undefined && input.hintedNeed !== input.parentNeedId) return null;
  if (input.removalNeed !== input.parentNeedId) return null;
  if (input.parent && input.parent.id !== input.parentNeedId) return null;
  const resolved = !!input.parent && input.parent.stated === 0 && input.parent.acceptedOffer === input.offerId;
  return { subject: input.parent?.subject, resolved };
}

/** Sample, mesh, and local rows. A verified removal drops every copy of that id. */
export function composeForumNeeds(input: {
  pilot: readonly ForumNeed[];
  mesh: readonly ForumNeed[];
  local: readonly ForumNeed[];
  removed: ReadonlySet<string>;
}): Map<string, ForumNeed> {
  const map = new Map<string, ForumNeed>();
  for (const need of input.pilot) {
    if (input.removed.has(need.id)) continue;
    map.set(need.id, need);
  }
  for (const need of input.mesh) {
    if (input.removed.has(need.id)) continue;
    const base = map.get(need.id);
    if (!base || need.hamState >= base.hamState) map.set(need.id, need);
  }
  for (const need of input.local) {
    if (input.removed.has(need.id)) continue;
    const base = map.get(need.id);
    if (!base || need.hamState > base.hamState) map.set(need.id, need);
  }
  return map;
}

/**
 * A signed cancel stays. Decline and withdraw set `stated` 0, and no verb
 * sets that same offer id back to `stated` 1. A later live row is a replay.
 */
export function mergeForumOffer(current: ForumOffer | undefined, incoming: ForumOffer): ForumOffer | null {
  if (!current || current.id !== incoming.id) return incoming;
  if (current.stated === 0 && incoming.stated === 1) return null;
  return incoming;
}

/** A verified cancel soul names this offer. The live replay does not win. */
export function offerBlockedByCancel(cancels: ReadonlySet<string>, offer: ForumOffer): boolean {
  return offer.stated === 1 && cancels.has(offer.id);
}

export type ForumMeshRemoval = {
  removed: 1;
  action: "remove";
  forumId: string;
  id: string;
  kind: "need" | "offer";
  need?: string;
};

/** Signed removal of a need or offer. Unsigned `null` is not a removal. */
export function parseForumMeshRemoval(value: unknown): ForumMeshRemoval | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.removed !== 1 || row.action !== "remove") return null;
  if (row.kind !== "need" && row.kind !== "offer") return null;
  if (typeof row.forumId !== "string" || typeof row.id !== "string") return null;
  if (!isForumObjectId(row.forumId, "forum")) return null;
  if (row.kind === "need") {
    if (!isForumObjectId(row.id, "need")) return null;
    return { removed: 1, action: "remove", forumId: row.forumId, id: row.id, kind: "need" };
  }
  if (!isForumObjectId(row.id, "offer") || typeof row.need !== "string" || !isForumObjectId(row.need, "need")) {
    return null;
  }
  return {
    removed: 1,
    action: "remove",
    forumId: row.forumId,
    id: row.id,
    kind: "offer",
    need: row.need,
  };
}

/**
 * Need: admitted owner or subject. Offer: helper, need owner, or subject.
 * The map key is the object id. A grant is not this signature.
 */
export function authorizeForumMeshRemoval(input: {
  removal: ForumMeshRemoval;
  mapKey: string;
  signer: string;
  owner: string | undefined;
  subject: string | undefined;
  forumId: string;
  parentNeedId?: string;
  /** Need `stated` 0 names this offer. The helper may not remove it. */
  resolved?: boolean;
}): boolean {
  const removal = input.removal;
  if (removal.forumId !== input.forumId || input.mapKey !== removal.id) return false;
  if (!isSeaPubkey(input.signer)) return false;
  if (removal.kind === "need") {
    if (input.owner && input.signer === input.owner) return true;
    return !!input.subject && input.signer === input.subject;
  }
  if (!removal.need || removal.need !== input.parentNeedId) return false;
  const helper = sameEmbeddedPrincipal(input.signer, removal.id);
  if (input.resolved && helper) return false;
  if (helper) return true;
  if (input.owner && input.signer === input.owner) return true;
  return !!input.subject && input.signer === input.subject;
}

/** Sample roster plus mesh rows. A verified removal drops that pubkey, including a fixture. */
export function composeForumRoster(input: {
  sample: readonly SquadAgent[];
  mesh: readonly ForumAgentStatus[];
  admitted?: ReadonlySet<string>;
  removed: ReadonlySet<string>;
}): SquadAgent[] {
  return mergeAgents(input.sample, input.mesh, input.admitted).filter(
    (agent) => !input.removed.has(agent.status.seaPubkey),
  );
}

export function mergeAgents(
  sample: readonly SquadAgent[],
  mesh: readonly ForumAgentStatus[],
  admitted?: ReadonlySet<string>,
): SquadAgent[] {
  const roster = admitted ?? new Set(sample.map((agent) => agent.status.seaPubkey));
  const byPub = new Map(sample.map((agent) => [agent.status.seaPubkey, agent]));
  for (const status of mesh) {
    const existing = byPub.get(status.seaPubkey);
    if (!existing && !roster.has(status.seaPubkey)) continue;
    if (existing) {
      byPub.set(status.seaPubkey, { ...existing, status });
      continue;
    }
    byPub.set(status.seaPubkey, {
      label: shortSea(status.seaPubkey),
      promptBy: "",
      artifactNote: "",
      status,
      subtasks: [],
      updates: [],
    });
  }
  return sortAgents([...byPub.values()]);
}
