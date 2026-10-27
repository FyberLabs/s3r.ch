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
  forumChatTag,
  forumChatTagPresent,
  forumChatTags,
  forumStatementSoul,
  isForumChatExtraTag,
  checkSee,
  isForumObjectId,
  isRoleToken,
  isSeaPubkey,
  sameAccessor,
  sameEmbeddedPrincipal,
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
  const entropy = input.entropy.trim();
  if (!/^[a-z0-9]+$/i.test(entropy)) return null;
  const tags = forumChatTags(input.forumId, input.extras ?? []);
  if (!tags) return null;
  const ts = Math.floor(input.now);
  const id = `stmt-${ts}-${entropy.toLowerCase()}`;
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
 * that owner, and a grant is kept only when the mesh owner is that same
 * admitted owner. Objects the sample does not admit still read the user graph.
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
      const admitted = sample.ownerOf(object);
      if (!admitted) return primary.seeGrants(object);
      if (!sameAccessor(primary.ownerOf(object), admitted)) return sample.seeGrants(object);
      return [...sample.seeGrants(object), ...primary.seeGrants(object)];
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
  if (!knownIds.some((known) => soulKeyMatches(known, mapKey))) return [];
  return [mapKey];
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
  forumId: string;
  seaPubkey: string;
  id: string;
};

/** Signed removal. Unsigned `null` is not a removal. */
export function parseForumAgentRemoval(value: unknown): ForumAgentRemoval | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.removed !== 1) return null;
  if (typeof row.forumId !== "string" || typeof row.seaPubkey !== "string" || typeof row.id !== "string") {
    return null;
  }
  if (!isForumObjectId(row.forumId, "forum") || !isForumObjectId(row.id, "status")) return null;
  if (!isSeaPubkey(row.seaPubkey) || !sameEmbeddedPrincipal(row.seaPubkey, row.id)) return null;
  return { removed: 1, forumId: row.forumId, seaPubkey: row.seaPubkey, id: row.id };
}

function ownerMayWrite(signer: string, owner: string | undefined): boolean {
  return !!owner && signer === owner && canWriteStatus(owner, signer);
}

/**
 * `owner` admits a new pubkey (forum owner, or the admitted owner of that
 * status when they are not the agent signing for themselves). `enrolled`
 * is a self-update of a pubkey already on the roster. `pending` is a
 * self-signature that must wait for admission. `denied` is ignored.
 */
export function forumStatusAdmission(input: {
  status: ForumAgentStatus;
  mapKey: string;
  signer: string;
  owner: string | undefined;
  forumOwner?: string;
  forumId: string;
  enrolled: boolean;
}): "owner" | "enrolled" | "pending" | "denied" {
  if (input.mapKey !== input.status.seaPubkey) return "denied";
  if (input.status.forumId !== input.forumId) return "denied";
  if (!isSeaPubkey(input.signer)) return "denied";
  if (ownerMayWrite(input.signer, input.forumOwner)) return "owner";
  if (ownerMayWrite(input.signer, input.owner) && input.signer !== input.status.seaPubkey) return "owner";
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
  owner: string | undefined;
  forumOwner?: string;
  forumId: string;
  enrolled: boolean;
}): boolean {
  const admission = forumStatusAdmission(input);
  return admission === "owner" || admission === "enrolled";
}

/** Agent or owner. The map key is the agent pubkey. Unsigned null is not this. */
export function authorizeForumAgentRemoval(input: {
  removal: ForumAgentRemoval;
  mapKey: string;
  signer: string;
  owner: string | undefined;
  forumOwner: string | undefined;
  forumId: string;
}): boolean {
  const removal = input.removal;
  if (removal.removed !== 1 || removal.forumId !== input.forumId) return false;
  if (input.mapKey !== removal.seaPubkey) return false;
  if (!isSeaPubkey(input.signer) || !sameEmbeddedPrincipal(removal.seaPubkey, removal.id)) return false;
  if (input.signer === removal.seaPubkey) return true;
  if (ownerMayWrite(input.signer, input.forumOwner)) return true;
  return ownerMayWrite(input.signer, input.owner);
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

/** Chat mesh rows are signed by the statement author. The tag does not grant. */
export function authorizeForumChat(
  item: FeedItem,
  signer: string,
  mapKey: string | undefined,
  forumId: string,
): boolean {
  if (signer !== item.author || !isSeaPubkey(signer)) return false;
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
    return livePostedOfferCloses(need, closure);
  }
  return !!owner && signer === owner;
}

function livePostedOfferCloses(need: ForumNeed, closure: ForumNeedClosure): boolean {
  const offerId = need.acceptedOffer;
  if (!offerId) return false;
  const posted = closure.postedOffers.get(offerId);
  if (!posted || !validateForumOffer(posted) || posted.stated !== 1) return false;
  if (posted.need !== need.id || posted.forumId !== need.forumId) return false;
  if (!closure.graph.hasObject(need.id)) return false;
  return checkSee(closure.graph, need.id, posted.helper, closure.now).allowed;
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
    if (offer.stated === 0) return true;
    if (!seen || seen.need.id !== offer.need || seen.need.forumId !== offer.forumId) return false;
    if (!seen.graph.hasObject(seen.need.id)) return false;
    return checkSee(seen.graph, seen.need.id, signer, seen.now).allowed;
  }
  if (offer.stated !== 0) return false;
  return signer === party?.owner || signer === party?.subject;
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
}): boolean {
  const removal = input.removal;
  if (removal.forumId !== input.forumId || input.mapKey !== removal.id) return false;
  if (!isSeaPubkey(input.signer)) return false;
  if (removal.kind === "need") {
    if (input.owner && input.signer === input.owner) return true;
    return !!input.subject && input.signer === input.subject;
  }
  if (!removal.need || removal.need !== input.parentNeedId) return false;
  if (sameEmbeddedPrincipal(input.signer, removal.id)) return true;
  if (input.owner && input.signer === input.owner) return true;
  return !!input.subject && input.signer === input.subject;
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
