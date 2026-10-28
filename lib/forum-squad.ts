/**
 * Squad forum view model. Souls and Check stay in `lib/identity/check.ts`.
 * Chat items are tagged `s3rch/items`. Role tokens are not predicates.
 */

import {
  GUN_PROTOCOL_V,
  fromGunNode,
  type FeedItem,
} from "@/lib/feed-types";
import { signatureOf } from "@/lib/forum-sign";
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
  return { ...status, state: "idle", lastUpdate: Math.max(now, status.lastUpdate + 1) };
}

export function reassignedStatus(
  status: ForumAgentStatus,
  target: string,
  now: number,
): ForumAgentStatus | null {
  if (!isSeaPubkey(target)) return null;
  return { ...status, lastUpdate: Math.max(now, status.lastUpdate + 1), result: `reassign ${target}` };
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
  let serial = 0;
  function id(scope: string, key: string): string {
    return `${scope}\n${key}`;
  }
  return {
    bump(scope, key) {
      const next = ++serial;
      versions.delete(id(scope, key));
      if (versions.size >= 1024) versions.delete(versions.keys().next().value!);
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
 * The owner's signature over the open need, carried inside the subject's close.
 * A cold start reads this instead of trusting the close's `subject` field.
 */
export function ownerAdmitSig(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const admit = (payload as { admit?: unknown }).admit;
  return typeof admit === "string" && admit.startsWith("SEA") ? admit : null;
}

/** Close record with the owner's open-need signature inside the signed payload. */
export function withOwnerAdmission<T extends ForumNeed>(need: T, admit: string): T & { admit: string } {
  return { ...need, admit };
}

/**
 * `open` is the need recovered from the owner's signature. It admits the
 * subject. The close may not rename that subject or rewrite the posted body.
 */
export function forumNeedAdmission(open: ForumNeed, close: ForumNeed): boolean {
  if (open.stated !== 1 || close.stated !== 0 || !close.acceptedOffer) return false;
  if (open.id !== close.id || open.forumId !== close.forumId) return false;
  if (!isSeaPubkey(open.subject) || open.subject !== close.subject) return false;
  if (open.body !== close.body || open.severity !== close.severity) return false;
  if ((open.spec ?? "") !== (close.spec ?? "")) return false;
  return close.hamState > open.hamState;
}

/**
 * A close (`stated` 0 with an accepted offer) uses the same live-offer and
 * helper Check see gates as accept. The subject is admitted by a prior row,
 * by the owner's signature on the close, or by the owner's open-need signature
 * carried inside the close. A payload `subject` alone is not that admission.
 * `admitted` is that verified open row, not an unsigned copy. The admitted
 * owner may sign any other need row. Accept does not elect.
 */
export function authorizeForumNeed(
  need: ForumNeed,
  signer: string,
  owner: string | undefined,
  forumId: string,
  known?: ForumNeed,
  closure?: ForumNeedClosure,
  admitted?: ForumNeed,
): boolean {
  if (need.forumId !== forumId || !isSeaPubkey(signer)) return false;
  if (known && (need.subject !== known.subject || need.hamState < known.hamState)) return false;
  known = freshestNeedAdmission(need, known, admitted);
  if (signer !== owner && !subjectClosureRevision(need, known)) return false;
  if (known && known.stated === 1 && need.stated === 0 && need.id === known.id) {
    const party = signer === owner || signer === known.subject;
    if (!party) return false;
    if (need.hamState <= known.hamState) return false;
    if (need.body !== known.body || need.severity !== known.severity) return false;
    if ((need.spec ?? "") !== (known.spec ?? "")) return false;
    if (!need.acceptedOffer || !closure) return false;
    return needClosureStatus(need, closure) === "ok";
  }
  if (!known && need.stated === 0 && need.acceptedOffer) {
    if (signer === owner) {
      if (!closure) return false;
      return needClosureStatus(need, closure) === "ok";
    }
    if (!admitted || signer !== admitted.subject || !forumNeedAdmission(admitted, need)) return false;
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

/**
 * The auth cache is the composed need. An older signed row must not replace
 * it: the board setters then keep the fresher row and never render, so the
 * cache would stay open after a close. `floor` is the persisted high-water
 * from an earlier page load.
 */
export function cacheForumNeed(
  cache: ReadonlyMap<string, ForumNeed>,
  incoming: ForumNeed,
  floor?: ForumNeed,
): Map<string, ForumNeed> | null {
  const cached = cache.get(incoming.id);
  const current = floor && floor.id === incoming.id && (!cached || floor.hamState > cached.hamState) ? floor : cached;
  if (current && current.hamState > incoming.hamState) return null;
  const next = new Map(cache);
  next.set(incoming.id, incoming);
  return next;
}

/** Highest accepted need per id. A lower signed ham does not replace it. */
export function raiseNeedHighWater(map: Map<string, ForumNeed>, need: ForumNeed): boolean {
  const current = map.get(need.id);
  if (current && current.hamState >= need.hamState) return false;
  map.set(need.id, need);
  return true;
}

export function serializeNeedHighWater(map: ReadonlyMap<string, ForumNeed>): string {
  return JSON.stringify([...map.values()]);
}

/** Drop a corrupt record. Keep the freshest valid need for each id. */
export function parseNeedHighWater(raw: string | null): Map<string, ForumNeed> {
  const map = new Map<string, ForumNeed>();
  if (!raw) return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return map;
  }
  if (!Array.isArray(parsed)) return map;
  for (const row of parsed) {
    const need = parseForumNeed(row);
    if (!need) continue;
    const existing = map.get(need.id);
    if (!existing || need.hamState > existing.hamState) map.set(need.id, need);
  }
  return map;
}

/** Helper pubkey embedded in an offer id. An unsigned hint is not required. */
export function offerHelperFromId(id: string): string | null {
  if (!isForumObjectId(id, "offer")) return null;
  const embedded = embeddedPrincipalKey(id);
  if (!embedded) return null;
  const pub = seaFromPrincipalKey(embedded);
  if (!pub || !sameEmbeddedPrincipal(pub, id)) return null;
  return pub;
}

/** Signers to try for an offer or its removal. The offer id names the helper. */
export function offerSignerCandidates(input: {
  offerId?: string;
  hintedHelper?: string;
  owner?: string;
  subject?: string;
}): string[] {
  const derived = input.offerId ? (offerHelperFromId(input.offerId) ?? "") : "";
  return [derived, input.hintedHelper ?? "", input.owner ?? "", input.subject ?? ""].filter(
    (pub, index, all) => pub && all.indexOf(pub) === index,
  );
}

/**
 * A removal or cancel with no verifier yet waits for the parent authority.
 * A live offer waits for its grant. Anything else is not queued.
 */
export function offerRowShouldQueue(input: {
  verified: boolean;
  fromCancel: boolean;
  fromRemoval: boolean;
  awaitingAuthority: boolean;
  waitingForGrant: boolean;
}): "authority" | "grant" | null {
  if (input.verified) return null;
  if ((input.fromCancel || input.fromRemoval) && input.awaitingAuthority) return "authority";
  if (input.waitingForGrant) return "grant";
  return null;
}

/**
 * Verified mesh chat replaces the copy this browser kept at send time.
 * A local row shows only until that mesh row arrives.
 */
export function mergeForumChat(input: {
  pilot: readonly FeedItem[];
  mesh: readonly FeedItem[];
  local: readonly FeedItem[];
  hidden: readonly string[];
}): FeedItem[] {
  const map = new Map<string, FeedItem>();
  const put = (item: FeedItem) => {
    for (const id of [...map.keys()]) {
      if (soulKeyMatches(id, item.id)) map.delete(id);
    }
    map.set(item.id, item);
  };
  for (const item of withoutChatIds(input.pilot, input.hidden)) put(item);
  for (const item of withoutChatIds(input.local, input.hidden)) put(item);
  for (const item of withoutChatIds(input.mesh, input.hidden)) put(item);
  return [...map.values()].filter(forumChatFits).slice(-FORUM_CHAT_CAP)
    .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}

/** Drop the local copy once its verified mesh row is in hand. */
export function retireLocalChat(local: readonly FeedItem[], meshId: string): FeedItem[] {
  let changed = false;
  const next = local.filter((row) => {
    const drop = soulKeyMatches(row.id, meshId);
    if (drop) changed = true;
    return !drop;
  });
  return changed ? next : (local as FeedItem[]);
}

/** Unverified needs waiting on an owner. Closure waits are counted apart. */
export const PENDING_NEED_CAP = 32;
export const PENDING_NEED_PER_PARENT = 16;
export const PENDING_NEED_TTL_MS = 5 * 60 * 1000;
export const PENDING_NEED_MAX_BYTES = 8192;

export type PendingNeedEntry = {
  data: unknown;
  gen: number;
  at: number;
  parentId: string;
  objectId: string;
  /** Retry this owner-wait only when `ownerOf(objectId)` is this pubkey. */
  expectOwner?: string;
  reason: "owner" | "closure";
  context?: ForumNeed;
  fromRemoval?: boolean;
};

export function prunePendingNeeds(queue: Map<string, PendingNeedEntry>, now: number): void {
  for (const [key, row] of queue) {
    if (now - row.at > PENDING_NEED_TTL_MS) queue.delete(key);
  }
}

/** Byte size of a pending gun row. Metadata and cycles are not retained. */
export function pendingNeedPayloadBytes(data: unknown): number | null {
  const seen = new Set<object>();
  function walk(value: unknown, depth: number): number | null {
    if (value == null) return 0;
    if (typeof value === "string") return value.length;
    if (typeof value === "number" || typeof value === "boolean") return 8;
    if (typeof value !== "object") return null;
    if (depth > 3 || seen.has(value)) return null;
    seen.add(value);
    let bytes = 0;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "_" || key === "#") continue;
      bytes += key.length;
      const nested = walk(child, depth + 1);
      if (nested === null) return null;
      bytes += nested;
      if (bytes > PENDING_NEED_MAX_BYTES) return bytes;
    }
    return bytes;
  }
  return walk(data, 0);
}

/**
 * Keep a pending need only inside the cap, the per-parent cap, the byte cap,
 * and the TTL. An unknown owner is not a reason to grow the queue without
 * bound. The same key replaces its previous row.
 */
export function retainPendingNeed(
  queue: Map<string, PendingNeedEntry>,
  key: string,
  entry: PendingNeedEntry,
  now: number,
): boolean {
  if (key !== pendingNeedKey(entry.objectId, entry.fromRemoval) || !isForumObjectId(entry.objectId, "need") || !entry.parentId) {
    queue.delete(key);
    return false;
  }
  const bytes = pendingNeedPayloadBytes(entry.data);
  if (bytes === null || bytes > PENDING_NEED_MAX_BYTES) {
    queue.delete(key);
    return false;
  }
  prunePendingNeeds(queue, now);
  if (queue.has(key)) {
    queue.set(key, { ...entry, at: Math.min(queue.get(key)!.at, entry.at) });
    return true;
  }
  if (entry.reason === "owner") {
    let parentCount = 0;
    let ownerRows = 0;
    for (const row of queue.values()) {
      if (row.reason !== "owner") continue;
      ownerRows += 1;
      if (row.parentId === entry.parentId) parentCount += 1;
    }
    if (parentCount >= PENDING_NEED_PER_PARENT || ownerRows >= PENDING_NEED_CAP) return false;
  } else {
    let closures = 0;
    for (const row of queue.values()) if (row.reason === "closure") closures += 1;
    if (closures >= PENDING_NEED_CAP) return false;
  }
  queue.set(key, entry);
  return true;
}

/**
 * Owner-wait rows retry only once that object's owner is loaded, and only
 * for the pubkey they named. Closure rows are already verified. Expired
 * rows drop.
 */
export function pendingNeedRetry(
  entry: PendingNeedEntry,
  now: number,
  owner: string | undefined,
): "retry" | "keep" | "drop" {
  if (now - entry.at > PENDING_NEED_TTL_MS) return "drop";
  if (entry.reason === "closure") return "retry";
  if (!owner || !isSeaPubkey(owner)) return "keep";
  if (entry.expectOwner && entry.expectOwner !== owner) return "drop";
  return "retry";
}

export const PENDING_OFFER_CAP = 32;
export const PENDING_OFFER_PER_PARENT = 16;
export const PENDING_OFFER_TTL_MS = 5 * 60 * 1000;

export type PendingOfferEntry = {
  data: unknown;
  key: string;
  parentNeedId: string;
  gen: number;
  at: number;
  fromCancel?: boolean;
  fromRemoval?: boolean;
  reason: "grant" | "authority";
};

export function prunePendingOffers(queue: Map<string, PendingOfferEntry>, now: number): void {
  for (const [key, row] of queue) {
    if (now - row.at > PENDING_OFFER_TTL_MS) queue.delete(key);
  }
}

/**
 * Pending offers share the need bounds: a cap, a per-need cap, a byte cap,
 * and a TTL. The same key keeps its original timestamp.
 */
export function retainPendingOffer(
  queue: Map<string, PendingOfferEntry>,
  queueKey: string,
  entry: PendingOfferEntry,
  now: number,
): boolean {
  if (!entry.parentNeedId || !isForumObjectId(entry.parentNeedId, "need")) {
    queue.delete(queueKey);
    return false;
  }
  if (!entry.key || !isForumObjectId(entry.key, "offer")) {
    queue.delete(queueKey);
    return false;
  }
  const bytes = pendingNeedPayloadBytes(entry.data);
  if (bytes === null || bytes > PENDING_NEED_MAX_BYTES) {
    queue.delete(queueKey);
    return false;
  }
  prunePendingOffers(queue, now);
  const previous = queue.get(queueKey);
  if (previous) {
    queue.set(queueKey, { ...entry, at: Math.min(previous.at, entry.at) });
    return true;
  }
  let parentCount = 0;
  for (const row of queue.values()) if (row.parentNeedId === entry.parentNeedId) parentCount += 1;
  if (parentCount >= PENDING_OFFER_PER_PARENT || queue.size >= PENDING_OFFER_CAP) return false;
  queue.set(queueKey, entry);
  return true;
}

/** Retry while the row is inside its TTL. Expired rows drop. */
export function pendingOfferRetry(entry: PendingOfferEntry, now: number): "retry" | "drop" {
  if (now - entry.at > PENDING_OFFER_TTL_MS) return "drop";
  return "retry";
}

/** Offer cancel and removal subscriptions. Open only after the offer verifies. */
export const OFFER_TAIL_WATCH_CAP = 128;
export const OFFER_TAIL_WATCH_PER_NEED = 16;
export const OFFER_TAIL_WATCH_TTL_MS = 12 * 60 * 60 * 1000;

/** A child of `offers` may be read only when the key is an offer id with a SEA signature. */
export function offerTailCandidate(needId: string, key: string, data: unknown): boolean {
  if (!isForumObjectId(needId, "need") || !isForumObjectId(key, "offer")) return false;
  if (key.length > 200 || key.includes("/") || key.includes("\0")) return false;
  return !!signatureOf(data);
}

export function takeExpiredOfferTailWatches(watches: Map<string, number>, now: number): string[] {
  const expired: string[] = [];
  for (const [key, at] of watches) {
    if (now - at > OFFER_TAIL_WATCH_TTL_MS) {
      expired.push(key);
      watches.delete(key);
    }
  }
  return expired;
}

export function grantOfferTailWatch(input: {
  watches: Map<string, number>;
  needId: string;
  offerId: string;
  verified: boolean;
  now: number;
}): boolean {
  if (!input.verified || !offerTailCandidate(input.needId, input.offerId, { sig: "SEA" })) return false;
  const id = `${input.needId}:${input.offerId}`;
  if (input.watches.has(id)) {
    input.watches.set(id, input.now);
    return false;
  }
  let onNeed = 0;
  for (const key of input.watches.keys()) {
    if (key.startsWith(`${input.needId}:`)) onNeed += 1;
  }
  if (onNeed >= OFFER_TAIL_WATCH_PER_NEED || input.watches.size >= OFFER_TAIL_WATCH_CAP) return false;
  input.watches.set(id, input.now);
  return true;
}

/** Verified forum-chat removal subscriptions. A quiet key expires. */
export const CHAT_REMOVAL_WATCH_CAP = 128;
export const CHAT_REMOVAL_WATCH_TTL_MS = 12 * 60 * 60 * 1000;

function chatRemovalKeyBounded(key: string): boolean {
  if (key.length < 1 || key.length > 200) return false;
  if (key.includes("/") || key.includes("\0")) return false;
  return true;
}

/**
 * An items-map child may be considered for a removal subscription only when
 * the key is bounded and the node already carries this forum's tag or a
 * forum tombstone plus a SEA signature. That is not verification.
 */
export function chatRemovalCandidate(key: string, data: unknown, forumId: string): boolean {
  if (!chatRemovalKeyBounded(key) || !signatureOf(data)) return false;
  const live = forumStatementFromNode(data, forumId);
  if (live) return soulKeyMatches(live.id, key);
  if (!data || typeof data !== "object") return false;
  const row = data as Record<string, unknown>;
  if (row.unshared !== 1 || row.forumId !== forumId) return false;
  return typeof row.id === "string" && soulKeyMatches(row.id, key);
}

/** Keys whose watch TTL has elapsed. The caller unsubscribes them. */
export function takeExpiredChatRemovalWatches(watches: Map<string, number>, now: number): string[] {
  const expired: string[] = [];
  for (const [key, at] of watches) {
    if (now - at > CHAT_REMOVAL_WATCH_TTL_MS) {
      expired.push(key);
      watches.delete(key);
    }
  }
  return expired;
}

/**
 * Open a removal subscription only after the row verified, and only inside
 * the cap. An existing key refreshes its TTL and does not subscribe again.
 */
export function grantChatRemovalWatch(input: {
  watches: Map<string, number>;
  key: string;
  verified: boolean;
  now: number;
}): boolean {
  if (!input.verified || !chatRemovalKeyBounded(input.key)) return false;
  if (input.watches.has(input.key)) {
    input.watches.set(input.key, input.now);
    return false;
  }
  if (input.watches.size >= CHAT_REMOVAL_WATCH_CAP) return false;
  input.watches.set(input.key, input.now);
  return true;
}

export type ForumAlarmUpdate =
  | { kind: "pin"; alarm: ForumAlarm; rev: number }
  | { kind: "unpin"; forumId: string; rev: number };

/**
 * Owner-signed alarm state. `rev` is the monotonic HAM value inside the
 * signature. A pin or unpin without it is not a state change.
 */
export function parseForumAlarmUpdate(value: unknown, forumId: string): ForumAlarmUpdate | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.forumId !== forumId) return null;
  if (typeof row.rev !== "number" || !Number.isSafeInteger(row.rev) || row.rev < 1) return null;
  if (row.pinned === 0) return { kind: "unpin", forumId, rev: row.rev };
  if (row.pinned !== 1 || typeof row.need !== "string" || !isForumObjectId(row.need, "need")) return null;
  return { kind: "pin", alarm: { forumId, need: row.need, pinned: 1 }, rev: row.rev };
}

/** A replay at or below the last accepted rev does not replace the pin. */
export function commitForumAlarm(
  state: { rev?: number },
  update: ForumAlarmUpdate,
): { rev: number; alarm: ForumAlarm | null } | null {
  if (state.rev !== undefined && update.rev <= state.rev) return null;
  if (update.kind === "unpin") return { rev: update.rev, alarm: null };
  return { rev: update.rev, alarm: update.alarm };
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
  return offer.stated === 1 && cancels.has(forumOfferCacheKey(offer.need, offer.id));
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


/** Cache identity includes the authenticated parent, not only the helper's id. */
export function forumOfferCacheKey(need: string, offer: string): string {
  return JSON.stringify([need, offer]);
}

/** Adapt the board's parent-scoped cache to the single-need Check contract. */
export function offersForNeed(offers: ReadonlyMap<string, ForumOffer>, need: string): Map<string, ForumOffer> {
  return new Map([...offers.values()].filter((offer) => offer.need === need).map((offer) => [offer.id, offer]));
}

/** Verified context for offer hydration; never installs a closure on the board. */
export function pendingClosureContext(need: ForumNeed, signer: string, owner: string | undefined,
  known?: ForumNeed, admitted?: ForumNeed): ForumNeed | undefined {
  if (need.stated !== 0 || !need.acceptedOffer) return undefined;
  if (known && (known.subject !== need.subject || known.hamState > need.hamState)) return undefined;
  known = freshestNeedAdmission(need, known, admitted);
  if (signer !== owner && !subjectClosureRevision(need, known)) return undefined;
  if (signer === owner || (admitted && signer === admitted.subject && forumNeedAdmission(admitted, need))) return need;
  if (known && signer === known.subject && forumNeedAdmission(known, need)) return need;
  return undefined;
}

export function needSignerCandidates(owner?: string, subject?: string, hint?: unknown): string[] {
  return [...new Set([owner, subject, typeof hint === "string" ? hint : undefined])]
    .filter((pub): pub is string => !!pub && isSeaPubkey(pub));
}

export const STATUS_CACHE_CAP = 128;
export const PENDING_STATUS_TTL_MS = 5 * 60 * 1000;
export const STATUS_WATCH_TTL_MS = 12 * 60 * 60 * 1000;
export type PendingStatus = { status: ForumAgentStatus; at: number };
export function prunePendingStatuses(queue: Map<string, PendingStatus>, now: number): void {
  for (const [pub, entry] of queue) if (now - entry.at >= PENDING_STATUS_TTL_MS) queue.delete(pub);
}
export function retainPendingStatus(queue: Map<string, PendingStatus>, status: ForumAgentStatus, now: number): boolean {
  prunePendingStatuses(queue, now);
  const old = queue.get(status.seaPubkey);
  if (old && old.status.lastUpdate >= status.lastUpdate) return false;
  if (!old && queue.size >= STATUS_CACHE_CAP) return false;
  queue.set(status.seaPubkey, { status, at: old?.at ?? now });
  return true;
}
/** Call only for an authenticated and admitted status. Equal revisions are idempotent only. */
export function cacheForumStatus(cache: Map<string, ForumAgentStatus>, status: ForumAgentStatus): boolean {
  const old = cache.get(status.seaPubkey);
  if (old && old.lastUpdate >= status.lastUpdate) return JSON.stringify(old) === JSON.stringify(status);
  if (!old && cache.size >= STATUS_CACHE_CAP) return false;
  cache.set(status.seaPubkey, status);
  return true;
}
export function parseStatusHighWater(raw: string | null, forumId: string): Map<string, ForumAgentStatus> {
  const cache = new Map<string, ForumAgentStatus>();
  if (!raw || raw.length > 2_000_000) return cache;
  try {
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > STATUS_CACHE_CAP) return cache;
    for (const row of rows) {
      const status = parseForumAgentStatus(row);
      if (status?.forumId === forumId) cacheForumStatus(cache, status);
    }
  } catch { /* Corrupt local storage is not a mesh row. */ }
  return cache;
}
export function statusWatchCandidate(key: string, data: unknown): boolean {
  return isSeaPubkey(key) && key.length <= 200 && !!signatureOf(data);
}
export function grantStatusWatch(watches: Map<string, number>, pub: string, verified: boolean, now: number): boolean {
  if (!verified || !isSeaPubkey(pub)) return false;
  if (watches.has(pub)) { watches.set(pub, now); return false; }
  if (watches.size >= STATUS_CACHE_CAP) return false;
  watches.set(pub, now);
  return true;
}
export function expireStatusWatches(watches: Map<string, number>, now: number): string[] {
  const expired: string[] = [];
  for (const [pub, at] of watches) if (now - at >= STATUS_WATCH_TTL_MS) { watches.delete(pub); expired.push(pub); }
  return expired;
}


/** Live need and removal callbacks retain independent versions and queue slots. */
export function pendingNeedKey(id: string, fromRemoval = false): string {
  return fromRemoval ? `remove:${id}` : id;
}

/** Subjects may close the admitted open revision once, never choose an arbitrary HAM. */
export function subjectClosureRevision(need: ForumNeed, admitted?: ForumNeed): boolean {
  return !!admitted && admitted.stated === 1 && need.stated === 0 &&
    need.hamState === admitted.hamState + 1 && need.hamState < Number.MAX_SAFE_INTEGER - 1;
}

/** Reserve one second of the accepted future window for an owner override. */
export function statusRevisionAllowed(status: ForumAgentStatus, signer: string, owner: string | undefined, now: number): boolean {
  return Number.isSafeInteger(status.lastUpdate) && status.lastUpdate >= 0 &&
    status.lastUpdate < Number.MAX_SAFE_INTEGER && status.lastUpdate <= now + (signer === owner ? 300 : 299);
}

export type ForumWatchKind = "need" | "offers" | "role";
export const FORUM_WATCH_CAP = 128;
export const FORUM_WATCH_PER_KIND = 64;
export const ROLE_PROBE_CAP = 16;
export const ROLE_PROBE_TTL_MS = 30_000;
export const FORUM_WATCH_TTL_MS = 12 * 60 * 60 * 1000;
export type ForumWatch = { kind: ForumWatchKind; at: number; verified: boolean };
export function expireForumWatches(watches: Map<string, ForumWatch>, now: number): string[] {
  const expired: string[] = [];
  for (const [id, watch] of watches) {
    if (now - watch.at >= (watch.verified ? FORUM_WATCH_TTL_MS : ROLE_PROBE_TTL_MS)) {
      watches.delete(id); expired.push(id);
    }
  }
  return expired;
}
/** Role children need a short bounded discovery read before a membership can verify. */
export function grantForumWatch(watches: Map<string, ForumWatch>, kind: ForumWatchKind,
  key: string, verified: boolean, now: number): boolean {
  if (kind === "role" ? !isRoleToken(key) : !isForumObjectId(key, "need")) return false;
  if (!verified && kind !== "role") return false;
  const id = `${kind}:${key}`;
  const old = watches.get(id);
  if (old) {
    if (verified) watches.set(id, { kind, at: now, verified: true });
    return false; // Untrusted events cannot extend a probe's deadline.
  }
  const same = [...watches.values()].filter(row => row.kind === kind).length;
  const probes = [...watches.values()].filter(row => !row.verified).length;
  if (watches.size >= FORUM_WATCH_CAP || same >= FORUM_WATCH_PER_KIND || (!verified && probes >= ROLE_PROBE_CAP)) return false;
  watches.set(id, { kind, at: now, verified });
  return true;
}


/** Only a verified, matching owner admission may supersede remembered state. */
export function freshestNeedAdmission(need: ForumNeed, known?: ForumNeed, admitted?: ForumNeed): ForumNeed | undefined {
  if (!admitted || !forumNeedAdmission(admitted, need)) return known;
  if (known && (known.id !== admitted.id || known.forumId !== admitted.forumId || known.subject !== admitted.subject)) return known;
  return !known || admitted.hamState > known.hamState ? admitted : known;
}

export const FORUM_CHAT_CAP = 256;
export const FORUM_CHAT_ROW_CHARS = 16_384;
export function forumChatFits(item: FeedItem): boolean {
  return JSON.stringify(item).length <= FORUM_CHAT_ROW_CHARS;
}
/** Bounded recent deliveries, including edits. Remote timestamps do not control eviction. */
export function retainForumChat(rows: readonly FeedItem[], incoming: FeedItem): FeedItem[] {
  if (!forumChatFits(incoming)) return [...rows].slice(-FORUM_CHAT_CAP);
  return [...rows.filter(row => !soulKeyMatches(row.id, incoming.id)), incoming].slice(-FORUM_CHAT_CAP);
}
