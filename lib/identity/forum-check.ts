/**
 * Forum slice of the light Check consume contract.
 *
 * Souls match SociACL forums at 8471edc and `lib/identity/vectors/forums.json`.
 * These paths are data.
 * They are not grant souls. Chat is a GunFeedNode under `s3rch/items`.
 *
 * The account key is the GunDB SEA pubkey. A wallet is not that key.
 * A need update is accepted when Check see allows the writer on that
 * need id. There is no second owner-or-delegate test in this file.
 */

import type { GunFeedNode } from "@/lib/feed-types";

export type ForumAgentState = "idle" | "working" | "needs" | "emergency";

export type ForumAgentStatus = {
  /** Minted object id of kind `status`. The embedded principal is the agent. */
  id: string;
  forumId: string;
  seaPubkey: string;
  task: string;
  result: string;
  /** Comma-separated need object ids. Empty when there are none. */
  needs: string;
  progress: number;
  state: ForumAgentState;
  lastPrompt: string;
  lastUpdate: number;
  type: string;
  started: number;
  tokens: number;
  runtime: number;
  hb?: number;
  batt?: number;
  link?: number;
  /** Comma-separated object ids. Empty when there are none. */
  artifacts?: string;
};

export type ForumNeedSeverity = "need" | "emergency";

export type ForumNeed = {
  id: string;
  forumId: string;
  /**
   * SEA pubkey the need is about. Not compared to the forum id or to
   * the principal embedded in that id.
   */
  subject: string;
  severity: ForumNeedSeverity;
  body: string;
  stated: 0 | 1;
  hamState: number;
  ts: number;
  /** Optional object id of a function contract. Omitted when the need is free-form. */
  spec?: string;
  /**
   * Offer id chosen by the owner or the subject.
   * Empty when none is accepted. Check see does not set this.
   */
  acceptedOffer?: string;
};

/**
 * Help offered against a need. The helper owns this row.
 * Soul: `s3rch/forums/<forumId>/needs/<needId>/offers/<offerId>`.
 * `forumId` is the Gun field `forum_id`. `acceptedOffer` on the need is `accepted_offer`.
 */
export type ForumOffer = {
  id: string;
  need: string;
  forumId: string;
  helper: string;
  body: string;
  artifacts: string;
  stated: 0 | 1;
};

/** An offer verb. `elect` stays false. Accept does not choose a new owner. */
export type ForumOfferDecision =
  | { ok: true; elect: false; offer?: ForumOffer; need?: ForumNeed }
  | { ok: false; reason: string; elect: false };

export type ForumAlarm = {
  forumId: string;
  need: string;
  pinned: 1;
};

export type ForumRoleMode = "distinct-principals" | "role-labels";

export type ForumTemplate = {
  forumId: string;
  mode: ForumRoleMode;
};

export type ForumRoleMembership = {
  forumId: string;
  role: string;
  principal: string;
};

/** Same GunFeedNode. Tags include `forum:<forumId>`. No added field. */
export type ForumChatItem = GunFeedNode;

export type ForumNeedDecision =
  | { ok: true; need: ForumNeed; elect: false }
  | { ok: false; reason: string; elect: false };

const MINTED = /^([a-z][a-z0-9]*)_p_[0-9a-f]{128}_[0-9a-f]{32}$/;
const SEA_SHAPE = /^[A-Za-z0-9_-]{8,128}\.[A-Za-z0-9_-]{8,128}$/;
const RESERVED_ROLE = new Set([
  "acl",
  "agents",
  "alarm",
  "chat",
  "forums",
  "items",
  "meta",
  "needs",
  "roles",
  "s3rch",
  "subtasks",
  "template",
  "updates",
  "users",
]);

const AGENT_STATES = new Set<ForumAgentState>(["idle", "working", "needs", "emergency"]);

function scalarLength(value: string): number {
  return [...value].length;
}

function unpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function badSegment(value: string): boolean {
  if (typeof value !== "string") return true;
  if (value.length === 0 || scalarLength(value) > 256) return true;
  if (value !== value.trim()) return true;
  if (unpairedSurrogate(value)) return true;
  if (/[\u0000-\u0020\u007f-\u009f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/.test(value)) {
    return true;
  }
  if (/[/#$[\]~]/.test(value)) return true;
  if (value.includes(".get(")) return true;
  return false;
}

function b64urlBytes(segment: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const pad = "=".repeat((4 - (segment.length % 4)) % 4);
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/") + pad;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function hexBytes(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** `p_` plus the 64-byte uncompressed point, lowercase hex. */
export function seaToPrincipalKey(pub: string): string | null {
  if (!SEA_SHAPE.test(pub) || badSegment(pub)) return null;
  const [x, y] = pub.split(".");
  const xb = b64urlBytes(x);
  const yb = b64urlBytes(y);
  if (!xb || !yb || xb.length !== 32 || yb.length !== 32) return null;
  return `p_${hexBytes(xb)}${hexBytes(yb)}`;
}

function bytesFromHex(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Inverse of `seaToPrincipalKey`. A bad key is null. */
export function seaFromPrincipalKey(key: string): string | null {
  if (!/^p_[0-9a-f]{128}$/.test(key)) return null;
  const hex = key.slice(2);
  const x = bytesFromHex(hex.slice(0, 64));
  const y = bytesFromHex(hex.slice(64));
  if (!x || !y) return null;
  const pub = `${bytesToB64url(x)}.${bytesToB64url(y)}`;
  return seaToPrincipalKey(pub) === key ? pub : null;
}

export function isSeaPubkey(value: string): boolean {
  return seaToPrincipalKey(value) !== null;
}

export function isForumObjectId(value: string, kind?: string): boolean {
  if (badSegment(value) || !MINTED.test(value)) return false;
  if (!kind) return true;
  return MINTED.exec(value)?.[1] === kind;
}

/** Principal key embedded in a minted object id, or null. */
export function embeddedPrincipalKey(objectId: string): string | null {
  if (!isForumObjectId(objectId)) return null;
  const match = objectId.match(/_(p_[0-9a-f]{128})_[0-9a-f]{32}$/);
  return match?.[1] ?? null;
}

/** True when the SEA pubkey and the object id name one principal. */
export function sameEmbeddedPrincipal(seaPubkey: string, objectId: string): boolean {
  const embedded = embeddedPrincipalKey(objectId);
  const key = seaToPrincipalKey(seaPubkey);
  return !!embedded && !!key && embedded === key;
}

function assertMinted(id: string, kind?: string): void {
  if (!isForumObjectId(id, kind)) throw new Error("bad-id");
}

function assertSea(pub: string): void {
  if (!isSeaPubkey(pub)) throw new Error("bad-principal");
}

export function isRoleToken(value: string): boolean {
  if (typeof value !== "string" || badSegment(value)) return false;
  if (value.length < 1 || value.length > 32) return false;
  if (!/^[a-z][a-z0-9-]*$/.test(value)) return false;
  if (RESERVED_ROLE.has(value)) return false;
  return true;
}

function assertRole(token: string): void {
  if (!isRoleToken(token)) throw new Error("bad-role");
}

function u64(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function csvObjectIds(value: string, kind?: string): boolean {
  if (value === "") return true;
  const seen = new Set<string>();
  for (const part of value.split(",")) {
    if (!isForumObjectId(part, kind)) return false;
    if (seen.has(part)) return false;
    seen.add(part);
  }
  return true;
}

export function validateForumNeed(need: ForumNeed): boolean {
  if (need.stated !== 0 && need.stated !== 1) return false;
  if (!u64(need.hamState) || need.hamState >= Number.MAX_SAFE_INTEGER || !u64(need.ts)) return false;
  if (!isSeaPubkey(need.subject)) return false;
  if (need.severity !== "need" && need.severity !== "emergency") return false;
  if (typeof need.body !== "string") return false;
  if (need.spec !== undefined && !isForumObjectId(need.spec)) return false;
  if (
    need.acceptedOffer !== undefined &&
    need.acceptedOffer !== "" &&
    !isForumObjectId(need.acceptedOffer, "offer")
  ) {
    return false;
  }
  return isForumObjectId(need.id, "need") && isForumObjectId(need.forumId, "forum");
}

export function validateForumOffer(offer: ForumOffer): boolean {
  if (offer.stated !== 0 && offer.stated !== 1) return false;
  if (!isSeaPubkey(offer.helper)) return false;
  if (!sameEmbeddedPrincipal(offer.helper, offer.id)) return false;
  if (typeof offer.body !== "string" || offer.body.trim() === "") return false;
  if (!csvObjectIds(offer.artifacts, undefined)) return false;
  return (
    isForumObjectId(offer.id, "offer") &&
    isForumObjectId(offer.need, "need") &&
    isForumObjectId(offer.forumId, "forum")
  );
}

export function validateForumStatus(status: ForumAgentStatus): boolean {
  if (!isForumObjectId(status.id, "status")) return false;
  if (!isForumObjectId(status.forumId, "forum")) return false;
  if (!isSeaPubkey(status.seaPubkey)) return false;
  if (!sameEmbeddedPrincipal(status.seaPubkey, status.id)) return false;
  if (!csvObjectIds(status.needs, "need")) return false;
  if (!csvObjectIds(status.artifacts ?? "", undefined)) return false;
  if (!AGENT_STATES.has(status.state)) return false;
  if (typeof status.task !== "string" || typeof status.result !== "string") return false;
  if (typeof status.lastPrompt !== "string" || typeof status.type !== "string" || !status.type) {
    return false;
  }
  if (![status.progress, status.lastUpdate, status.started, status.tokens, status.runtime].every(u64)) {
    return false;
  }
  if (status.lastUpdate >= Number.MAX_SAFE_INTEGER) return false;
  if (status.hb !== undefined && !u64(status.hb)) return false;
  if (status.batt !== undefined && !u64(status.batt)) return false;
  if (status.link !== undefined && !u64(status.link)) return false;
  return true;
}

function forumRoot(forumId: string): string {
  assertMinted(forumId, "forum");
  return `s3rch/forums/${forumId}`;
}

/** `s3rch/forums/<forumId>/agents/<seaPubkey>`. */
export function forumAgentSoul(forumId: string, seaPubkey: string): string {
  assertSea(seaPubkey);
  return `${forumRoot(forumId)}/agents/${seaPubkey}`;
}

/** `s3rch/forums/<forumId>/needs/<needId>`. */
export function forumNeedSoul(forumId: string, needId: string): string {
  assertMinted(needId, "need");
  return `${forumRoot(forumId)}/needs/${needId}`;
}

/** Minted offer id. The embedded principal is the helper. */
export function mintForumOfferId(helper: string, entropy: string): string | null {
  const key = seaToPrincipalKey(helper);
  const tail = entropy.trim().toLowerCase();
  if (!key || !/^[0-9a-f]{32}$/.test(tail)) return null;
  const id = `offer_${key}_${tail}`;
  return isForumObjectId(id, "offer") && sameEmbeddedPrincipal(helper, id) ? id : null;
}

/** `s3rch/forums/<forumId>/needs/<needId>/offers/<offerId>`. The helper owns the offer. */
export function forumOfferSoul(forumId: string, needId: string, offerId: string): string {
  assertMinted(offerId, "offer");
  return `${forumNeedSoul(forumId, needId)}/offers/${offerId}`;
}

/** `s3rch/forums/<forumId>/alarm`. */
export function forumAlarmSoul(forumId: string): string {
  return `${forumRoot(forumId)}/alarm`;
}

/** `s3rch/forums/<forumId>/template`. */
export function forumTemplateSoul(forumId: string): string {
  return `${forumRoot(forumId)}/template`;
}

/** `s3rch/forums/<forumId>/roles/<roleToken>/<seaPubkey>`. */
export function forumRoleSoul(forumId: string, roleToken: string, seaPubkey: string): string {
  assertRole(roleToken);
  assertSea(seaPubkey);
  return `${forumRoot(forumId)}/roles/${roleToken}/${seaPubkey}`;
}

/** Child of the agent status soul. The id must carry a principal. */
export function forumSubtaskSoul(forumId: string, seaPubkey: string, subtaskId: string): string {
  assertMinted(subtaskId);
  return `${forumAgentSoul(forumId, seaPubkey)}/subtasks/${subtaskId}`;
}

/** Child of the agent status soul. The id must carry a principal. */
export function forumUpdateSoul(forumId: string, seaPubkey: string, updateId: string): string {
  assertMinted(updateId);
  return `${forumAgentSoul(forumId, seaPubkey)}/updates/${updateId}`;
}

/** `forum:<forumId>`. Not a soul. */
export function forumChatTag(forumId: string): string {
  assertMinted(forumId, "forum");
  return `forum:${forumId}`;
}

/**
 * Item soul for a forum statement. `s3rch/items/<key>`.
 * A path with a `chat` segment is refused.
 */
export function forumStatementSoul(itemId: string): string {
  if (badSegment(itemId) || itemId === "chat") throw new Error("bad-id");
  if (
    itemId.startsWith("s3rch:chat:") ||
    itemId.startsWith("s3rch:forum-msg:") ||
    itemId.startsWith("s3rch:forum:")
  ) {
    throw new Error("bad-id");
  }
  const key = itemId.replace(/[.#$[\]]/g, "_");
  const soul = `s3rch/items/${key}`;
  if (isSeparateChatSoul(soul)) throw new Error("bad-id");
  return soul;
}

/** True for `s3rch/chat` and for any soul that has a `chat` segment. */
export function isSeparateChatSoul(path: string): boolean {
  if (path === "s3rch/chat" || path.startsWith("s3rch/chat/")) return true;
  return path.split("/").some((segment) => segment === "chat");
}

/** Lowercase already. `chat`, a comma, and a slash are rejected. */
export function isForumChatExtraTag(tag: string): boolean {
  if (typeof tag !== "string" || tag.length === 0 || scalarLength(tag) > 256) return false;
  if (tag === "chat") return false;
  if (/[A-Z]/.test(tag)) return false;
  if (tag.includes("/") || tag.includes(".get(")) return false;
  if (/[,#$[\]~]/.test(tag)) return false;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(tag) || /\s/u.test(tag)) return false;
  return true;
}

export function forumChatTags(forumId: string, extras: readonly string[]): string[] | null {
  let required: string;
  try {
    required = forumChatTag(forumId);
  } catch {
    return null;
  }
  const out = [required];
  const seen = new Set<string>([required]);
  for (const extra of extras) {
    if (!isForumChatExtraTag(extra)) return null;
    if (seen.has(extra)) continue;
    seen.add(extra);
    out.push(extra);
  }
  return out;
}

export function forumChatTagWire(forumId: string, extras: readonly string[]): string | null {
  const tags = forumChatTags(forumId, extras);
  if (!tags) return null;
  return tags.join(",");
}

export function forumChatTagPresent(tags: string, forumId: string): boolean {
  let required: string;
  try {
    required = forumChatTag(forumId);
  } catch {
    return false;
  }
  return tags.split(",").some((item) => item === required);
}

/**
 * Distinct principals: one SEA pubkey per role token.
 * Role labels: every token names the same pubkey.
 * An empty set matches either mode. A role token is not a Check predicate.
 */
export function acceptForumRoles(
  mode: string,
  rows: readonly { role: string; principal: string }[],
): boolean {
  if (mode !== "distinct-principals" && mode !== "role-labels") return false;
  if (rows.some((row) => !isRoleToken(row.role) || !isSeaPubkey(row.principal))) return false;
  if (mode === "distinct-principals") {
    const roles = new Set<string>();
    const principals = new Set<string>();
    for (const row of rows) {
      if (roles.has(row.role) || principals.has(row.principal)) return false;
      roles.add(row.role);
      principals.add(row.principal);
    }
    return true;
  }
  const roles = new Set<string>();
  let principal: string | null = null;
  for (const row of rows) {
    if (roles.has(row.role)) return false;
    roles.add(row.role);
    if (principal === null) principal = row.principal;
    else if (principal !== row.principal) return false;
  }
  return true;
}

/**
 * Pin counts when the alarm names this open emergency in the same forum.
 * A need that fails validation does not pin.
 */
export function forumAlarmPins(
  alarm: { forumId: string; need: string; pinned: number },
  need: { id: string; forumId: string; severity: string; stated: number },
): boolean {
  if (alarm.pinned !== 1) return false;
  if (!isForumObjectId(alarm.forumId, "forum") || !isForumObjectId(alarm.need, "need")) return false;
  if (!isForumObjectId(need.id, "need") || !isForumObjectId(need.forumId, "forum")) return false;
  if (need.stated !== 0 && need.stated !== 1) return false;
  return (
    alarm.forumId === need.forumId &&
    alarm.need === need.id &&
    need.severity === "emergency" &&
    need.stated === 1
  );
}

/** Tile `emergency` or a live pin. Either one is enough. Not a grant. */
export function forumEmergencyAlarm(
  states: readonly string[],
  alarm: { forumId: string; need: string; pinned: number } | null,
  need: { id: string; forumId: string; severity: string; stated: number } | null,
): boolean {
  const tiles = states.some((state) => state === "emergency");
  const pin = alarm && need ? forumAlarmPins(alarm, need) : false;
  return tiles || pin;
}

/**
 * Next need row when Check already allowed the writer.
 * `hamState` must rise. `id`, `forumId`, `subject`, and `body` stay.
 * `severity`, `spec`, `stated`, and `acceptedOffer` stay.
 * Closing and reopening are offer verbs.
 * Does not elect. Does not read a hint or a hop.
 * Does not look at why Check allowed.
 */
export function transitionForumNeed(
  current: ForumNeed,
  next: ForumNeed,
  see: { allowed: boolean; reason: string },
): ForumNeedDecision {
  if (!validateForumNeed(current) || !validateForumNeed(next)) {
    return { ok: false, reason: "bad-need", elect: false };
  }
  if (next.id !== current.id || next.forumId !== current.forumId || next.subject !== current.subject) {
    return { ok: false, reason: "bad-need", elect: false };
  }
  if (next.body !== current.body) {
    return { ok: false, reason: "body", elect: false };
  }
  if (next.severity !== current.severity) {
    return { ok: false, reason: "severity", elect: false };
  }
  if ((next.spec ?? "") !== (current.spec ?? "")) {
    return { ok: false, reason: "spec", elect: false };
  }
  if (!u64(next.hamState) || next.hamState <= current.hamState) {
    return { ok: false, reason: "ham", elect: false };
  }
  if (next.stated !== current.stated) {
    return { ok: false, reason: "stated", elect: false };
  }
  if ((next.acceptedOffer ?? "") !== (current.acceptedOffer ?? "")) {
    return { ok: false, reason: "accepted-offer", elect: false };
  }
  if (!see.allowed) return { ok: false, reason: see.reason, elect: false };
  return { ok: true, need: { ...next }, elect: false };
}
