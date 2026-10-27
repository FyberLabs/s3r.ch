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
  isForumObjectId,
  isSeaPubkey,
  validateForumNeed,
  validateForumOffer,
  validateForumStatus,
  type ForumAgentState,
  type ForumAgentStatus,
  type ForumAlarm,
  type ForumNeed,
  type ForumOffer,
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

/** User graph wins ownership. Sample fills objects the user graph lacks. */
export function overlaySeeGraph(primary: SeeGraph, sample: SeeGraph): SeeGraph {
  return {
    hasObject(object) {
      return primary.hasObject(object) || sample.hasObject(object);
    },
    ownerOf(object) {
      return primary.ownerOf(object) ?? sample.ownerOf(object);
    },
    seeGrants(object) {
      return [...primary.seeGrants(object), ...sample.seeGrants(object)];
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
 * Ids to drop when a chat put is a tombstone, Gun `null`, or no longer a
 * forum statement. `undefined` is not a retract. Only the Gun map key can
 * name the line, and only when it soul-matches a line already shown. An
 * unsigned payload `id` on a tombstone is not a hide target.
 */
export function chatRetractionIds(
  data: unknown,
  key: string | undefined,
  knownIds: readonly string[],
): string[] {
  if (data === undefined) return [];
  const mapKey = typeof key === "string" ? key.trim() : "";
  if (!mapKey) return [];
  if (!knownIds.some((known) => soulKeyMatches(known, mapKey))) return [];
  return [mapKey];
}

export function withoutChatIds(items: readonly FeedItem[], ids: readonly string[]): FeedItem[] {
  if (ids.length === 0) return [...items];
  return items.filter((item) => !ids.some((id) => soulKeyMatches(item.id, id)));
}

/**
 * Mesh status may replace a roster tile only when the signature signer is
 * the agent pubkey or the admitted owner, and the Gun map key is that agent.
 */
export function authorizeForumStatus(input: {
  status: ForumAgentStatus;
  mapKey: string;
  signer: string;
  owner: string | undefined;
  forumId: string;
}): boolean {
  if (input.mapKey !== input.status.seaPubkey) return false;
  if (input.status.forumId !== input.forumId) return false;
  if (!isSeaPubkey(input.signer)) return false;
  if (input.signer === input.status.seaPubkey) return true;
  return input.signer === input.owner && canWriteStatus(input.owner, input.signer);
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

/**
 * A need row is signed by the admitted owner, or by the subject when the
 * row accepts an offer and leaves body, severity, and spec as posted.
 * Accept does not elect.
 */
export function authorizeForumNeed(
  need: ForumNeed,
  signer: string,
  owner: string | undefined,
  forumId: string,
  known?: ForumNeed,
): boolean {
  if (need.forumId !== forumId || !isSeaPubkey(signer)) return false;
  if (owner && signer === owner) return true;
  if (!known || signer !== known.subject || signer !== need.subject) return false;
  if (need.stated !== 0 || !need.acceptedOffer) return false;
  if (need.id !== known.id || need.hamState <= known.hamState) return false;
  if (need.body !== known.body || need.severity !== known.severity) return false;
  return (need.spec ?? "") === (known.spec ?? "");
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
 * The helper signs a post or a withdrawal. The need owner or subject may
 * sign a cancel (`stated` 0). A live row is not signed by a third party.
 */
export function authorizeForumOffer(
  offer: ForumOffer,
  signer: string,
  forumId: string,
  party?: { owner?: string; subject?: string },
): boolean {
  if (offer.forumId !== forumId || !isSeaPubkey(signer)) return false;
  if (signer === offer.helper) return true;
  if (offer.stated !== 0) return false;
  return signer === party?.owner || signer === party?.subject;
}

export function mergeAgents(sample: readonly SquadAgent[], mesh: readonly ForumAgentStatus[]): SquadAgent[] {
  const byPub = new Map(sample.map((agent) => [agent.status.seaPubkey, agent]));
  for (const status of mesh) {
    const existing = byPub.get(status.seaPubkey);
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
