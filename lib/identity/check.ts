/**
 * Light SociACL Check — `CHECK(see, object, accessor)` at `now`.
 *
 * Reimplements the consume contract in `docs/s3rch-check.d.ts`.
 * Runs in the browser. Does not import FyberLabs/SociACL (crate, NAPI,
 * WASM, or npm). hopcap 1: do not walk friend edges. Hint never sets
 * `allowed`. Hop never sets `allowed`. Privilege-down (`cancelSee`) is
 * immediate on dest ACL. Owner-only cancel must bump HAM so cancel
 * wins the next merge.
 */

import { getAddress } from "viem";
import {
  fromGunNode,
  isUnsharePut,
  protocolVersionOf,
  toGunNode,
  type GunFeedNode,
  type GunUserNode,
  type IdentitySeeGrant,
} from "@/lib/feed-types";

export { fromGunNode, toGunNode };
export type {
  FeedItem,
  FeedSource,
  GunFeedNode,
  GunUserNode,
  IdentityClaimKind,
  IdentitySeeGrant,
} from "@/lib/feed-types";

/** Locked Gun root. */
export type S3rchRoot = "s3rch";

export const S3RCH_ROOT = "s3rch" as const;
export const S3RCH_ITEMS = "items" as const;
export const S3RCH_ROOMS = "rooms" as const;
export const S3RCH_CHAT = "chat" as const;
export const S3RCH_PRESENCE = "presence" as const;
export const S3RCH_USERS = "users" as const;
export const S3RCH_GRANTED = "granted" as const;
export const S3RCH_ACL = "acl" as const;
export const S3RCH_META = "meta" as const;

/** Dest ACL collection. Sibling of items / users / meta. Not a Check object. */
export type S3rchAcl = typeof S3RCH_ACL;

/**
 * Held-claim CheckObjectId prefixes. The object id is the claim id
 * itself, linked from GunUserNode.indicators. s3r.ch #46 also links
 * `farcaster:` (same family as consume-contract `fc:`).
 */
export type HeldClaimPrefix =
  | "ens:"
  | "unstoppable:"
  | "fc:"
  | "farcaster:"
  | "lens:"
  | "rss3:";

/**
 * gun.get('s3rch').get('rooms').get(encodeKey(id))
 * Gun cannot store arrays: `tags` is a comma-separated string.
 */
export type GunRoomNode = {
  id: string;
  title: string;
  owner: string;
  tags: string;
  ts: number;
  provenance: string;
  /** Missing on older nodes; treat as v1. Unknown versions fail closed. */
  v?: number;
  /**
   * HAM unshare marker. `1` means retract. Missing / null is live.
   * Any other present value fails closed (readers drop).
   */
  unshared?: number | null;
};

/**
 * gun.get('s3rch').get('rooms').get(encodeKey(room)).get('chat').get(encodeKey(id))
 * Short live-thread message. Native Check object. No signatures on the node.
 */
export type GunChatNode = {
  id: string;
  room: string;
  author: string;
  body: string;
  ts: number;
  /** Missing on older nodes; treat as v1. Unknown versions fail closed. */
  v?: number;
};

/**
 * gun.get('s3rch').get('rooms').get(encodeKey(room)).get('presence').get(encodeKey(address))
 * Soft-TTL heartbeat. Native Check object. No signatures or held claims on the node.
 */
export type GunPresenceNode = {
  room: string;
  address: string;
  ts: number;
  /** Missing on older nodes; treat as v1. Unknown versions fail closed. */
  v?: number;
};

/**
 * Untrusted edge handoff (ingest / seeder / URL cross).
 * Decode does not verify. A hint never sets allowed.
 */
export type HandoffHint = {
  principal: string;
  target: string;
  verb?: string;
  context?: string;
};

/**
 * Permalink, RSS3 GI, RSS/Atom, or issuer HTTP.
 * Not a Gun node. Not a grant. A URL 200 is not see.
 */
export type UrlLeaf = {
  url: string;
};

/** Seed cache. gun.get('s3rch').get('meta'). Not a Check object. */
export type FeedMeta = {
  seededAt?: string;
  sourcesOk: number;
  sourcesTried: number;
  error?: string;
  count: number;
};

/** Feed item soul or claim id linked from the user node. */
export type CheckObjectId = string;

/** Wallet or s3rch/users/{wallet}. */
export type AccessorId = string;

export type CheckResult = {
  allowed: boolean;
  /**
   * Predicate / deny reason. A present hint never makes this a grant.
   * A present hop never makes this a grant.
   */
  reason: string;
};

/** Named Social Light channels. Hop is not a grant. */
export type SocialLightChannel = "convention-badge" | "enrolled-station";

/**
 * Optional Check factor. Opaque SLHP bytes or the structured hop
 * sociacl-core already names. Destination re-authorizes.
 * Hop missing does not fail. Hop alone never allows.
 * Hop never mints a grant. URL handoffs stay untrusted HandoffHint.
 */
export type HopFactor =
  | Uint8Array
  | {
      channel: SocialLightChannel;
      attestationBytes?: Uint8Array;
      shareToken?: string;
    };

/**
 * In-graph see grant. HAM-merges across peers.
 * `stated` 1 = jointly stated, 0 = cancelled (privilege-down).
 */
export type MeshSeeGrant = {
  object: CheckObjectId;
  accessor: AccessorId;
  from: number;
  until: number;
  stated: 0 | 1;
};

/**
 * One dest-ACL grant node. Soul is grantSoul(owner, object, accessor).
 * Peers HAM-merge by hamState (higher wins). Cancel bumps hamState.
 */
export type GunAclEdge = {
  soul: string;
  owner: AccessorId;
  grant: MeshSeeGrant;
  hamState: number;
};

/**
 * Live graph the browser reads. Only in-graph objects and jointly
 * stated see grants. Do not walk friend edges (hopcap 1).
 *
 * Mesh: each peer evaluates against its locally HAM-merged Gun graph
 * at now. Do not cache an allow across a privilege-down merge.
 */
export type SeeGraph = {
  hasObject(object: CheckObjectId): boolean;
  ownerOf(object: CheckObjectId): AccessorId | undefined;
  seeGrants(object: CheckObjectId): readonly IdentitySeeGrant[];
};

/** Writable dest ACL. Cancel and admit land here, not on a URL. */
export type SeeAcl = SeeGraph & {
  putObject(object: CheckObjectId, owner: AccessorId): void;
  stateSeeGrant(owner: AccessorId, grant: IdentitySeeGrant): void;
  unstateSeeGrant(
    owner: AccessorId,
    accessor: AccessorId,
    object: CheckObjectId,
  ): void;
};

/** id.replace(/[.#$\[\]]/g, '_') */
export function encodeKey(id: string): string {
  return id.replace(/[.#$[\]]/g, "_");
}

/** s3rch/items/<encodeKey(id)> */
export function itemSoul(id: string): string {
  return `${S3RCH_ROOT}/${S3RCH_ITEMS}/${encodeKey(id)}`;
}

/** s3rch/rooms/<encodeKey(id)> */
export function roomSoul(id: string): string {
  return `${S3RCH_ROOT}/${S3RCH_ROOMS}/${encodeKey(id)}`;
}

/** s3rch/rooms/<encodeKey(roomId)>/chat/<encodeKey(id)> */
export function chatSoul(roomId: string, messageId: string): string {
  return `${roomSoul(roomId)}/${S3RCH_CHAT}/${encodeKey(messageId)}`;
}

/** s3rch/rooms/<encodeKey(roomId)>/presence/<encodeKey(address)> */
export function presenceSoul(roomId: string, address: string): string {
  return `${roomSoul(roomId)}/${S3RCH_PRESENCE}/${encodeKey(address)}`;
}

/** s3rch/users/<wallet> — checksum when the key is an address. */
export function userSoul(wallet: string): string {
  const trimmed = wallet.trim();
  try {
    return `${S3RCH_ROOT}/${S3RCH_USERS}/${getAddress(trimmed)}`;
  } catch {
    return `${S3RCH_ROOT}/${S3RCH_USERS}/${trimmed}`;
  }
}

export type GrantInboxKind = "items" | "rooms" | "users";

/**
 * Grant-delivery inbox. Not share-into-mesh.
 * gun.get('s3rch').get('granted').get(accessor).get(kind).get(encodeKey(id))
 */
export function grantedSoul(
  accessor: AccessorId,
  kind: GrantInboxKind,
  objectId: string,
): string {
  const trimmed = accessor.trim();
  let wallet = trimmed;
  if (trimmed.startsWith(`${S3RCH_ROOT}/${S3RCH_USERS}/`)) {
    wallet = trimmed.slice(`${S3RCH_ROOT}/${S3RCH_USERS}/`.length);
  }
  try {
    wallet = getAddress(wallet);
  } catch {
    wallet = wallet.trim();
  }
  return `${S3RCH_ROOT}/${S3RCH_GRANTED}/${wallet}/${kind}/${encodeKey(objectId)}`;
}

/** s3rch/meta — not a Check object. */
export function metaSoul(): string {
  return `${S3RCH_ROOT}/${S3RCH_META}`;
}

/**
 * Dest-ACL path key. encodeKey, then `/` → `_`, so a grant soul stays
 * five segments when the object id still contains slashes.
 */
export function aclKey(id: string): string {
  return encodeKey(id).replace(/\//g, "_");
}

/**
 * Owner / accessor key on dest ACL. `s3rch/users/<wallet>` collapses
 * to the wallet. Anything else is aclKey.
 */
export function aclPrincipalKey(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return "";
  let key = trimmed;
  if (trimmed.startsWith(`${S3RCH_ROOT}/${S3RCH_USERS}/`)) {
    key = trimmed.slice(`${S3RCH_ROOT}/${S3RCH_USERS}/`.length);
  }
  try {
    return getAddress(key);
  } catch {
    return aclKey(key);
  }
}

/**
 * Owner dest-ACL root. Not a Check object.
 * gun.get('s3rch').get('acl').get(aclPrincipalKey(owner))
 */
export function aclSoul(owner: AccessorId): string {
  return `${S3RCH_ROOT}/${S3RCH_ACL}/${aclPrincipalKey(owner)}`;
}

/**
 * Jointly stated see grant under the object owner's dest ACL.
 * gun.get('s3rch').get('acl')
 *   .get(aclPrincipalKey(owner))
 *   .get(aclKey(object))
 *   .get(aclPrincipalKey(accessor))
 */
export function grantSoul(
  owner: AccessorId,
  object: CheckObjectId,
  accessor: AccessorId,
): string {
  return `${aclSoul(owner)}/${aclKey(object)}/${aclPrincipalKey(accessor)}`;
}

/** Does not verify. Does not mint. */
export function acceptHint(hint: HandoffHint): HandoffHint {
  return {
    principal: hint.principal,
    target: hint.target,
    ...(hint.verb !== undefined ? { verb: hint.verb } : {}),
    ...(hint.context !== undefined ? { context: hint.context } : {}),
  };
}

const SOCIAL_LIGHT_CHANNELS: readonly SocialLightChannel[] = [
  "convention-badge",
  "enrolled-station",
];

function isSocialLightChannel(value: string): value is SocialLightChannel {
  return (SOCIAL_LIGHT_CHANNELS as readonly string[]).includes(value);
}

/**
 * Identity. Does not verify. Does not mint. Mirror acceptHint.
 */
export function acceptHop(hop: HopFactor): HopFactor {
  if (hop instanceof Uint8Array) return hop;
  return {
    channel: hop.channel,
    ...(hop.attestationBytes !== undefined
      ? { attestationBytes: hop.attestationBytes }
      : {}),
    ...(hop.shareToken !== undefined ? { shareToken: hop.shareToken } : {}),
  };
}

function readUtf8(bytes: Uint8Array, start: number, length: number): string | null {
  if (length > 4096 || start + length > bytes.length) return null;
  try {
    return new TextDecoder().decode(bytes.subarray(start, start + length));
  } catch {
    return null;
  }
}

/**
 * SLHP decode. Does not verify. Does not mint. Mirror acceptHint.
 * Attestation bytes stay opaque. Unparsed bytes stay the hop.
 */
export function decodeHop(bytes: Uint8Array): HopFactor {
  if (bytes.length < 10) return bytes;
  if (bytes[0] !== 0x53 || bytes[1] !== 0x4c || bytes[2] !== 0x48 || bytes[3] !== 0x50) {
    return bytes;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== 1) return bytes;
  const payloadLen = view.getUint32(6, true);
  if (10 + payloadLen !== bytes.length) return bytes;
  let offset = 10;
  if (offset + 4 > bytes.length) return bytes;
  const channelLen = view.getUint32(offset, true);
  offset += 4;
  const channel = readUtf8(bytes, offset, channelLen);
  if (channel === null) return bytes;
  offset += channelLen;
  if (offset + 4 > bytes.length) return bytes;
  const attLen = view.getUint32(offset, true);
  offset += 4;
  if (attLen > 65536 || offset + attLen > bytes.length) return bytes;
  const attestationBytes =
    attLen > 0 ? new Uint8Array(bytes.subarray(offset, offset + attLen)) : undefined;
  offset += attLen;
  if (offset + 1 > bytes.length) return bytes;
  const hasToken = bytes[offset];
  offset += 1;
  let shareToken: string | undefined;
  if (hasToken === 1) {
    if (offset + 4 > bytes.length) return bytes;
    const tokenLen = view.getUint32(offset, true);
    offset += 4;
    const token = readUtf8(bytes, offset, tokenLen);
    if (token === null) return bytes;
    shareToken = token;
    offset += tokenLen;
  } else if (hasToken !== 0) {
    return bytes;
  }
  if (offset !== bytes.length) return bytes;
  if (!isSocialLightChannel(channel)) return bytes;
  return {
    channel,
    ...(attestationBytes ? { attestationBytes } : {}),
    ...(shareToken !== undefined ? { shareToken } : {}),
  };
}

export function isUrlLeafId(id: string): boolean {
  return /^https?:\/\//i.test(id.trim());
}

export function isMetaId(id: string): boolean {
  const trimmed = id.trim();
  if (trimmed === metaSoul() || trimmed === S3RCH_META) return true;
  if (trimmed === `gun.get('${S3RCH_ROOT}').get('${S3RCH_META}')`) return true;
  if (trimmed === `gun.get("${S3RCH_ROOT}").get("${S3RCH_META}")`) return true;
  return false;
}

/** Dest ACL collection and grant souls are not Check objects. */
export function isAclId(id: string): boolean {
  const trimmed = id.trim();
  if (trimmed === `${S3RCH_ROOT}/${S3RCH_ACL}` || trimmed === S3RCH_ACL) return true;
  if (trimmed.startsWith(`${S3RCH_ROOT}/${S3RCH_ACL}/`)) return true;
  if (trimmed === `gun.get('${S3RCH_ROOT}').get('${S3RCH_ACL}')`) return true;
  if (trimmed === `gun.get("${S3RCH_ROOT}").get("${S3RCH_ACL}")`) return true;
  return false;
}

/**
 * Wallet as we name them → locked `s3rch/users/<wallet>`.
 * A soul path is left as-is. Not a second user node.
 */
export function accessorAliases(id: AccessorId): string[] {
  const trimmed = id.trim();
  if (!trimmed) return [];
  const aliases = new Set<string>([trimmed]);
  if (trimmed.startsWith(`${S3RCH_ROOT}/${S3RCH_USERS}/`)) {
    const wallet = trimmed.slice(`${S3RCH_ROOT}/${S3RCH_USERS}/`.length);
    if (wallet) {
      aliases.add(wallet);
      aliases.add(userSoul(wallet));
    }
    return [...aliases];
  }
  if (!trimmed.includes("/") && !trimmed.includes(".get(") && !isUrlLeafId(trimmed)) {
    aliases.add(userSoul(trimmed));
  }
  return [...aliases];
}

export function sameAccessor(
  left: AccessorId | undefined,
  right: AccessorId | undefined,
): boolean {
  if (!left || !right) return false;
  const rightAliases = new Set(accessorAliases(right));
  return accessorAliases(left).some((alias) => rightAliases.has(alias));
}

export function grantNamesObject(
  grant: IdentitySeeGrant,
  object: CheckObjectId,
): boolean {
  const claimId = grant.claimId.trim();
  if (!claimId) return false;
  if (claimId === object) return true;
  if (itemSoul(claimId) === object) return true;
  if (roomSoul(claimId) === object) return true;
  if (encodeKey(claimId) === object) return true;
  if (object.endsWith(`/${S3RCH_CHAT}/${encodeKey(claimId)}`)) return true;
  if (object.endsWith(`/${S3RCH_PRESENCE}/${encodeKey(claimId)}`)) return true;
  const user = userObjectId(claimId);
  if (user && user === object) return true;
  return false;
}

/** Wallet claim or existing user soul → locked `s3rch/users/<wallet>`. */
export function userObjectId(claimId: string): CheckObjectId | undefined {
  const trimmed = claimId.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith(`${S3RCH_ROOT}/${S3RCH_USERS}/`)) return userSoul(
    trimmed.slice(`${S3RCH_ROOT}/${S3RCH_USERS}/`.length),
  );
  try {
    return userSoul(getAddress(trimmed));
  } catch {
    return undefined;
  }
}

export function grantNamesAccessor(
  grant: IdentitySeeGrant,
  accessor: AccessorId,
): boolean {
  return sameAccessor(grant.accessor, accessor);
}

/** Owner of the object or a locked soul alias (item / room / user). */
export function ownerOwnsObject(
  acl: SeeAcl,
  owner: AccessorId,
  object: CheckObjectId,
): boolean {
  if (sameAccessor(acl.ownerOf(object), owner)) return true;
  if (sameAccessor(acl.ownerOf(itemSoul(object)), owner)) return true;
  if (sameAccessor(acl.ownerOf(roomSoul(object)), owner)) return true;
  const user = userObjectId(object);
  if (user && sameAccessor(acl.ownerOf(user), owner)) return true;
  return false;
}

/** `now ∈ [from, until)` — `from` inclusive, `until` exclusive. */
export function grantLiveAt(grant: IdentitySeeGrant, now: number): boolean {
  return now >= grant.from && now < grant.until;
}

/**
 * CHECK(see, object, accessor) at now.
 * see maps to dest read. Hint is ignored for allowed.
 * Hop missing does not fail. Hop alone never allows. Hop may only
 * factor an already-named grant or owner path.
 * Owner sees their object. Else a live IdentitySeeGrant / MeshSeeGrant
 * must name this pair and now ∈ [from, until). meta, dest ACL souls,
 * and UrlLeaf fail closed.
 */
export function checkSee(
  graph: SeeGraph,
  object: CheckObjectId,
  accessor: AccessorId,
  now: number,
  hint?: HandoffHint,
  hop?: HopFactor,
): CheckResult {
  void hint;
  void hop;
  if (isMetaId(object)) {
    return { allowed: false, reason: "meta" };
  }
  if (isAclId(object)) {
    return { allowed: false, reason: "acl" };
  }
  if (isUrlLeafId(object)) {
    return { allowed: false, reason: "url-leaf" };
  }
  if (!graph.hasObject(object)) {
    return { allowed: false, reason: "missing-object" };
  }
  if (sameAccessor(graph.ownerOf(object), accessor)) {
    return { allowed: true, reason: "owner" };
  }

  const named = graph
    .seeGrants(object)
    .filter((grant) => grantNamesObject(grant, object) && grantNamesAccessor(grant, accessor));
  const live = named.find((grant) => grantLiveAt(grant, now));
  if (live) {
    return { allowed: true, reason: "see-grant" };
  }
  if (named.length === 0) {
    return { allowed: false, reason: "missing-grant" };
  }
  if (named.every((grant) => now < grant.from)) {
    return { allowed: false, reason: "future-from" };
  }
  if (named.every((grant) => now >= grant.until)) {
    return { allowed: false, reason: "expired" };
  }
  return { allowed: false, reason: "denied" };
}

/**
 * Dest Check AND the presented grant window.
 * from denies until now is in range.
 */
export function checkSeeGrant(
  graph: SeeGraph,
  grant: IdentitySeeGrant,
  object: CheckObjectId,
  accessor: AccessorId,
  now: number,
  hint?: HandoffHint,
  hop?: HopFactor,
): CheckResult {
  const dest = checkSee(graph, object, accessor, now, hint, hop);
  if (!grantNamesObject(grant, object) || !grantNamesAccessor(grant, accessor)) {
    return { allowed: false, reason: dest.reason === "owner" ? "denied" : dest.reason };
  }
  if (!grantLiveAt(grant, now)) {
    const reason = now < grant.from ? "future-from" : "expired";
    return { allowed: false, reason };
  }
  return dest;
}

const USER_NODE_FORBIDDEN_KEYS = [
  "priv",
  "epriv",
  "signature",
  "siwe",
  "seaPair",
  "wrap",
  "paper",
  "dek",
  "kek",
  "walletSignature",
] as const;

function userNodeHasForbiddenSecrets(node: object): boolean {
  return USER_NODE_FORBIDDEN_KEYS.some((key) => key in node);
}

function splitUserIndicators(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || isUrlLeafId(trimmed) || isMetaId(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function userNodeAdmitted(node: GunUserNode): string | null {
  if (!node || typeof node !== "object") return null;
  if (isUnsharePut(node)) return null;
  if (userNodeHasForbiddenSecrets(node)) return null;
  if (typeof node.id !== "string" || !node.id.trim()) return null;
  if (protocolVersionOf(node.v) === null) return null;
  try {
    return getAddress(node.id);
  } catch {
    return null;
  }
}

function destOwner(owner: AccessorId): AccessorId | null {
  const trimmed = owner.trim();
  if (!trimmed) return null;
  if (isUrlLeafId(trimmed) || isMetaId(trimmed) || isAclId(trimmed)) return null;
  return trimmed;
}

/**
 * Destination re-authorizes, then may put a GunFeedNode into items.
 * Hint / URL fetch is not authorization.
 */
export function admitFeedNode(
  acl: SeeAcl,
  node: GunFeedNode,
  owner: AccessorId,
  hint?: HandoffHint,
): { object: CheckObjectId } | { denied: true } {
  void hint;
  const dest = destOwner(owner);
  const item = fromGunNode(node);
  if (!dest || !item) {
    return { denied: true };
  }
  const object = itemSoul(item.id);
  if (isMetaId(object) || isUrlLeafId(object)) {
    return { denied: true };
  }
  acl.putObject(object, dest);
  return { object };
}

function roomNodeAdmitted(node: GunRoomNode): string | null {
  if (!node || typeof node !== "object") return null;
  if (isUnsharePut(node)) return null;
  if (typeof node.id !== "string" || !node.id.trim()) return null;
  if (typeof node.title !== "string" || !node.title.trim()) return null;
  if (protocolVersionOf(node.v) === null) return null;
  return node.id.trim();
}

function chatNodeAdmitted(node: GunChatNode): { id: string; room: string } | null {
  if (!node || typeof node.id !== "string" || !node.id.trim()) return null;
  if (typeof node.room !== "string" || !node.room.trim()) return null;
  if (typeof node.author !== "string" || !node.author.trim()) return null;
  if (typeof node.body !== "string" || !node.body.trim()) return null;
  if (protocolVersionOf(node.v) === null) return null;
  return { id: node.id.trim(), room: node.room.trim() };
}

function samePresenceOwner(dest: AccessorId, address: string): boolean {
  if (sameAccessor(dest, address)) return true;
  try {
    const destWallet = dest.startsWith(`${S3RCH_ROOT}/${S3RCH_USERS}/`)
      ? dest.slice(`${S3RCH_ROOT}/${S3RCH_USERS}/`.length)
      : dest;
    return getAddress(destWallet) === getAddress(address);
  } catch {
    return false;
  }
}

function presenceNodeAdmitted(
  node: GunPresenceNode,
): { room: string; address: string } | null {
  if (!node || typeof node.room !== "string" || !node.room.trim()) return null;
  if (typeof node.address !== "string" || !node.address.trim()) return null;
  if (typeof node.ts !== "number" || !Number.isFinite(node.ts)) return null;
  if (protocolVersionOf(node.v) === null) return null;
  let address: string;
  try {
    address = getAddress(node.address);
  } catch {
    return null;
  }
  return { room: node.room.trim(), address };
}

/**
 * Destination re-authorizes, then may put a GunRoomNode into rooms.
 * Hint / URL fetch is not authorization. meta and UrlLeaf fail closed.
 */
export function admitRoomNode(
  acl: SeeAcl,
  node: GunRoomNode,
  owner: AccessorId,
  hint?: HandoffHint,
): { object: CheckObjectId } | { denied: true } {
  void hint;
  const dest = destOwner(owner);
  const id = roomNodeAdmitted(node);
  if (!dest || !id) {
    return { denied: true };
  }
  const object = roomSoul(id);
  if (isMetaId(object) || isUrlLeafId(object)) {
    return { denied: true };
  }
  acl.putObject(object, dest);
  return { object };
}

/**
 * Destination re-authorizes, then may put a GunChatNode onto a room's chat set.
 * Hint / URL fetch is not authorization. meta and UrlLeaf fail closed.
 * A grant is not a public put. Chat is not grant-delivered in this slice.
 */
export function admitChatNode(
  acl: SeeAcl,
  node: GunChatNode,
  owner: AccessorId,
  hint?: HandoffHint,
): { object: CheckObjectId } | { denied: true } {
  void hint;
  const dest = destOwner(owner);
  const admitted = chatNodeAdmitted(node);
  if (!dest || !admitted) {
    return { denied: true };
  }
  const object = chatSoul(admitted.room, admitted.id);
  if (isMetaId(object) || isUrlLeafId(object)) {
    return { denied: true };
  }
  acl.putObject(object, dest);
  if (admitted.id !== object) {
    acl.putObject(admitted.id, dest);
  }
  return { object };
}

/**
 * Destination re-authorizes, then may put a GunPresenceNode onto a room's presence set.
 * Hint / URL fetch is not authorization. meta and UrlLeaf fail closed.
 * Owner must be the address on the node. Presence is not grant-delivered
 * in this slice. Putting onto a Mine-only room path is the caller's gate.
 */
export function admitPresenceNode(
  acl: SeeAcl,
  node: GunPresenceNode,
  owner: AccessorId,
  hint?: HandoffHint,
): { object: CheckObjectId } | { denied: true } {
  void hint;
  const dest = destOwner(owner);
  const admitted = presenceNodeAdmitted(node);
  if (!dest || !admitted) {
    return { denied: true };
  }
  if (!samePresenceOwner(dest, admitted.address)) {
    return { denied: true };
  }
  const object = presenceSoul(admitted.room, admitted.address);
  if (isMetaId(object) || isUrlLeafId(object)) {
    return { denied: true };
  }
  acl.putObject(object, dest);
  return { object };
}

/**
 * Destination re-authorizes, then may put a GunUserNode into users.
 * Hint / URL fetch is not authorization. meta and UrlLeaf fail closed.
 * Owner must be the wallet on the node. Linked indicators are claim ids
 * (`ens:name.eth`), not `s3rch/users/{wallet}/claims/…`.
 * A grant is not share-into-mesh. Putting onto the public path is the
 * caller's explicit share gate.
 */
export function admitUserNode(
  acl: SeeAcl,
  node: GunUserNode,
  owner: AccessorId,
  hint?: HandoffHint,
): { object: CheckObjectId } | { denied: true } {
  void hint;
  const dest = destOwner(owner);
  const admitted = userNodeAdmitted(node);
  if (!dest || !admitted) {
    return { denied: true };
  }
  if (!samePresenceOwner(dest, admitted)) {
    return { denied: true };
  }
  const object = userSoul(admitted);
  if (isMetaId(object) || isUrlLeafId(object)) {
    return { denied: true };
  }
  acl.putObject(object, dest);
  acl.putObject(admitted, dest);
  for (const claim of splitUserIndicators(node.indicators)) {
    acl.putObject(claim, dest);
  }
  return { object };
}

function resolveGrantObject(
  acl: SeeAcl,
  grant: IdentitySeeGrant,
): CheckObjectId | undefined {
  const claimId = grant.claimId.trim();
  if (!claimId || isUrlLeafId(claimId) || isMetaId(claimId) || isAclId(claimId)) {
    return undefined;
  }
  if (acl.hasObject(claimId)) return claimId;
  const item = itemSoul(claimId);
  if (acl.hasObject(item)) return item;
  const room = roomSoul(claimId);
  if (acl.hasObject(room)) return room;
  if (claimId.includes(`/${S3RCH_CHAT}/`) && acl.hasObject(claimId)) return claimId;
  if (claimId.includes(`/${S3RCH_PRESENCE}/`) && acl.hasObject(claimId)) return claimId;
  const user = userObjectId(claimId);
  if (user && acl.hasObject(user)) return user;
  return undefined;
}

/** Jointly stated. hopcap 1. */
export function applySeeGrant(
  acl: SeeAcl,
  owner: AccessorId,
  grant: IdentitySeeGrant,
): void {
  const object = resolveGrantObject(acl, grant);
  if (!object) return;
  if (!sameAccessor(acl.ownerOf(object), owner)) return;
  if (isUrlLeafId(grant.accessor) || isMetaId(grant.accessor)) return;
  acl.stateSeeGrant(owner, grant);
}

/** Privilege-down is immediate. Dest ACL only. Owner-only. */
export function cancelSee(
  acl: SeeAcl,
  owner: AccessorId,
  accessor: AccessorId,
  object: CheckObjectId,
): void {
  if (!ownerOwnsObject(acl, owner, object)) return;
  acl.unstateSeeGrant(owner, accessor, object);
}
