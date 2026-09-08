/**
 * Live mesh delivery of granted Gun objects.
 *
 * A see-grant on the dest ACL is not login, not share-into-mesh, and not
 * a public put. Delivery is a holder-initiated put onto
 * `s3rch/granted/<accessor>/{items|rooms|users}/<encodeKey(id)>`.
 * The accessor `.map().on` that inbox after SIWE. Public / Network /
 * Discover never read this path. URL fetches stay handoffs.
 *
 * Privilege-down (`cancelSee`) is immediate on dest ACL. First delivery
 * / privilege-up can wait on the mesh. Unshare tombstones on
 * `s3rch/items|rooms|users` stay there — this path must not resurrect
 * those public rows.
 *
 * Writes `v: 1`. Unknown `v` fails closed. No SIWE / SEA secrets.
 */

import { getAddress } from "viem";
import { isNativePost } from "./compose";
import {
  GUN_PROTOCOL_V,
  protocolVersionOf,
  toGunNode,
  fromGunNode,
  type FeedItem,
  type GunFeedNode,
  type GunUserNode,
  type IdentitySeeGrant,
} from "./feed-types";
import {
  applySeeGrant,
  cancelSee,
  checkSee,
  encodeKey,
  grantLiveAt,
  grantedSoul,
  isMetaId,
  isUrlLeafId,
  itemSoul,
  roomSoul,
  sameAccessor,
  S3RCH_GRANTED,
  S3RCH_ITEMS,
  S3RCH_ROOMS,
  S3RCH_ROOT,
  S3RCH_USERS,
  userObjectId,
  userSoul,
  type AccessorId,
  type CheckObjectId,
  type GrantInboxKind,
  type SeeAcl,
} from "./identity/check";
import {
  fromGunRoomNode,
  toGunRoomNode,
  type GunRoomNode,
  type Room,
} from "./rooms";
import {
  composeUser,
  fromGunUserNode,
  isWalletClaimId,
  toGunUserNode,
  userNodeHasForbiddenSecrets,
  type User,
} from "./users";

export { grantedSoul, S3RCH_GRANTED };
export type { GrantInboxKind };

export const GRANT_DELIVERED_COPY =
  "Granted. It can take a moment to arrive.";

export const GRANT_DELIVERY_WAIT_COPY =
  "Granted. Waiting for a live connection.";

export const GRANT_REVOKED_COPY =
  "Revoked.";

export type GrantDeliveryKind = "item" | "room" | "user";

export type GunGrantDeliveryNode = {
  kind: GrantDeliveryKind;
  objectId: string;
  owner: string;
  accessor: string;
  from: number;
  until: number;
  payload: string;
  ts: number;
  /** Missing reads as v1. Unknown future versions fail closed. */
  v?: number;
};

export type GunGrantTombstone = {
  retracted: 1;
  kind: GrantDeliveryKind;
  objectId: string;
  owner: string;
  accessor: string;
  ts: number;
  v?: number;
};

export type GrantPutTarget = {
  accessorKey: string;
  kindKey: GrantInboxKind;
  objectKey: string;
  soul: string;
  node: GunGrantDeliveryNode | GunGrantTombstone;
};

export type PrepareGrantResult =
  | GrantPutTarget
  | { denied: true; reason: string };

export type AcceptedGrantDelivery =
  | { kind: "item"; item: FeedItem; grant: IdentitySeeGrant; owner: string }
  | { kind: "room"; room: Room; grant: IdentitySeeGrant; owner: string }
  | { kind: "user"; user: User; grant: IdentitySeeGrant; owner: string };

export type AcceptGrantResult =
  | AcceptedGrantDelivery
  | { retracted: true; objectId: string; kind: GrantDeliveryKind }
  | { denied: true; reason: string };

const FORBIDDEN_SECRET_KEYS = [
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

export function grantKindKey(kind: GrantDeliveryKind): GrantInboxKind {
  if (kind === "item") return "items";
  if (kind === "room") return "rooms";
  return "users";
}

export function grantDeliveryKindFromKey(
  key: string,
): GrantDeliveryKind | undefined {
  if (key === "items" || key === "item") return "item";
  if (key === "rooms" || key === "room") return "room";
  if (key === "users" || key === "user") return "user";
  return undefined;
}

export function checksumAccessor(accessor: string): string | null {
  const trimmed = accessor.trim();
  if (!trimmed) return null;
  const wallet = trimmed.startsWith(`${S3RCH_ROOT}/${S3RCH_USERS}/`)
    ? trimmed.slice(`${S3RCH_ROOT}/${S3RCH_USERS}/`.length)
    : trimmed;
  try {
    return getAddress(wallet);
  } catch {
    return null;
  }
}

/** Public graph souls. Delivery must not write these. */
export function isPublicGraphSoul(soul: string): boolean {
  const trimmed = soul.trim();
  if (trimmed.startsWith(`${S3RCH_ROOT}/${S3RCH_GRANTED}/`)) return false;
  return (
    trimmed.startsWith(`${S3RCH_ROOT}/${S3RCH_ITEMS}/`) ||
    trimmed.startsWith(`${S3RCH_ROOT}/${S3RCH_ROOMS}/`) ||
    trimmed.startsWith(`${S3RCH_ROOT}/${S3RCH_USERS}/`)
  );
}

export function isGrantDeliverableItem(
  item: Pick<FeedItem, "source" | "kind" | "id">,
): boolean {
  if (!item.id.trim() || isUrlLeafId(item.id) || isMetaId(item.id)) return false;
  return isNativePost(item);
}

function nodeHasForbiddenSecrets(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return FORBIDDEN_SECRET_KEYS.some((key) => key in record);
}

function encodePayload(value: object): string | null {
  if (nodeHasForbiddenSecrets(value)) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function decodePayload(raw: string): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    if (nodeHasForbiddenSecrets(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolveDeliveryObject(
  acl: SeeAcl,
  kind: GrantDeliveryKind,
  objectId: string,
): CheckObjectId | undefined {
  const claimId = objectId.trim();
  if (!claimId || isUrlLeafId(claimId) || isMetaId(claimId)) return undefined;
  if (acl.hasObject(claimId)) return claimId;
  if (kind === "item") {
    const item = itemSoul(claimId);
    if (acl.hasObject(item)) return item;
    return undefined;
  }
  if (kind === "room") {
    const room = roomSoul(claimId);
    if (acl.hasObject(room)) return room;
    return undefined;
  }
  const user = userObjectId(claimId);
  if (user && acl.hasObject(user)) return user;
  if (acl.hasObject(claimId)) return claimId;
  return undefined;
}

function deliveryGrant(
  objectId: string,
  accessor: string,
  from: number,
  until: number,
): IdentitySeeGrant {
  return { claimId: objectId, accessor, from, until };
}

function putTarget(
  kind: GrantDeliveryKind,
  objectId: string,
  accessor: string,
  node: GunGrantDeliveryNode | GunGrantTombstone,
): GrantPutTarget | { denied: true; reason: string } {
  const accessorKey = checksumAccessor(accessor);
  if (!accessorKey) return { denied: true, reason: "bad-accessor" };
  const kindKey = grantKindKey(kind);
  const objectKey = encodeKey(objectId);
  const soul = grantedSoul(accessorKey, kindKey, objectId);
  if (isPublicGraphSoul(soul) || isUrlLeafId(soul) || isMetaId(soul)) {
    return { denied: true, reason: "public-path" };
  }
  return { accessorKey, kindKey, objectKey, soul, node };
}

function requireLiveGrant(
  acl: SeeAcl,
  owner: AccessorId,
  accessor: AccessorId,
  kind: GrantDeliveryKind,
  objectId: string,
  now: number,
): CheckObjectId | undefined {
  const dest = checksumAccessor(owner);
  const who = checksumAccessor(accessor);
  if (!dest || !who || sameAccessor(dest, who)) return undefined;
  const object = resolveDeliveryObject(acl, kind, objectId);
  if (!object) return undefined;
  if (!sameAccessor(acl.ownerOf(object), dest)) return undefined;
  const result = checkSee(acl, object, who, now);
  if (!result.allowed) return undefined;
  return object;
}

function composeDeliveryNode(input: {
  kind: GrantDeliveryKind;
  objectId: string;
  owner: string;
  accessor: string;
  from: number;
  until: number;
  payload: string;
  ts: number;
}): GunGrantDeliveryNode | null {
  const owner = checksumAccessor(input.owner);
  const accessor = checksumAccessor(input.accessor);
  if (!owner || !accessor) return null;
  if (input.from >= input.until) return null;
  if (!input.objectId.trim() || !input.payload) return null;
  return {
    kind: input.kind,
    objectId: input.objectId.trim(),
    owner,
    accessor,
    from: input.from,
    until: input.until,
    payload: input.payload,
    ts: input.ts,
    v: GUN_PROTOCOL_V,
  };
}

/**
 * Holder: dest Check must already allow see at now, then put the
 * admitted native post onto the accessor's granted inbox.
 */
export function prepareGrantItemDelivery(
  acl: SeeAcl,
  item: FeedItem,
  owner: string,
  grant: IdentitySeeGrant,
  now: number,
): PrepareGrantResult {
  if (!isGrantDeliverableItem(item)) {
    return { denied: true, reason: "not-deliverable" };
  }
  const accessor = checksumAccessor(grant.accessor);
  const dest = checksumAccessor(owner);
  if (!accessor || !dest) return { denied: true, reason: "bad-accessor" };
  if (!grantLiveAt(grant, now)) return { denied: true, reason: "grant-window" };
  const object = requireLiveGrant(acl, dest, accessor, "item", item.id, now);
  if (!object) return { denied: true, reason: "check" };
  const payload = encodePayload(toGunNode(item));
  if (!payload) return { denied: true, reason: "payload" };
  const node = composeDeliveryNode({
    kind: "item",
    objectId: item.id,
    owner: dest,
    accessor,
    from: grant.from,
    until: grant.until,
    payload,
    ts: now,
  });
  if (!node) return { denied: true, reason: "node" };
  return putTarget("item", item.id, accessor, node);
}

/**
 * Holder: dest Check must already allow see at now, then put the
 * admitted room node onto the accessor's granted inbox.
 * Does not deliver posts, chat, or presence inside the room.
 */
export function prepareGrantRoomDelivery(
  acl: SeeAcl,
  room: Room,
  owner: string,
  grant: IdentitySeeGrant,
  now: number,
): PrepareGrantResult {
  const accessor = checksumAccessor(grant.accessor);
  const dest = checksumAccessor(owner);
  if (!accessor || !dest) return { denied: true, reason: "bad-accessor" };
  if (!grantLiveAt(grant, now)) return { denied: true, reason: "grant-window" };
  const object = requireLiveGrant(acl, dest, accessor, "room", room.id, now);
  if (!object) return { denied: true, reason: "check" };
  const payload = encodePayload(toGunRoomNode(room));
  if (!payload) return { denied: true, reason: "payload" };
  const node = composeDeliveryNode({
    kind: "room",
    objectId: room.id,
    owner: dest,
    accessor,
    from: grant.from,
    until: grant.until,
    payload,
    ts: now,
  });
  if (!node) return { denied: true, reason: "node" };
  return putTarget("room", room.id, accessor, node);
}

/**
 * Holder: dest Check must already allow see at now, then put a user
 * node that carries only the granted claim (wallet claim → empty
 * indicators). Does not dump the private footprint.
 */
export function prepareGrantUserDelivery(
  acl: SeeAcl,
  user: User,
  owner: string,
  grant: IdentitySeeGrant,
  now: number,
): PrepareGrantResult {
  const accessor = checksumAccessor(grant.accessor);
  const dest = checksumAccessor(owner);
  if (!accessor || !dest) return { denied: true, reason: "bad-accessor" };
  if (!grantLiveAt(grant, now)) return { denied: true, reason: "grant-window" };
  if (!sameAccessor(user.id, dest)) return { denied: true, reason: "owner" };

  const claimId = grant.claimId.trim();
  if (!claimId || isUrlLeafId(claimId) || isMetaId(claimId)) {
    return { denied: true, reason: "not-deliverable" };
  }

  const object = requireLiveGrant(acl, dest, accessor, "user", claimId, now);
  if (!object) return { denied: true, reason: "check" };

  const walletClaim = isWalletClaimId(claimId, user.id);
  const held = user.indicators.some(
    (row) => row.toLowerCase() === claimId.toLowerCase(),
  );
  if (!walletClaim && !held) return { denied: true, reason: "not-held" };

  const published = composeUser({
    address: user.id,
    indicators: walletClaim ? [] : [claimId],
    nowSeconds: now,
  });
  if (!published) return { denied: true, reason: "user" };
  const payload = encodePayload(toGunUserNode(published));
  if (!payload) return { denied: true, reason: "payload" };
  const node = composeDeliveryNode({
    kind: "user",
    objectId: claimId,
    owner: dest,
    accessor,
    from: grant.from,
    until: grant.until,
    payload,
    ts: now,
  });
  if (!node) return { denied: true, reason: "node" };
  return putTarget("user", claimId, accessor, node);
}

/** Privilege-down on the mesh: tombstone the grant-inbox row. */
export function prepareGrantRetract(
  owner: string,
  grant: IdentitySeeGrant,
  kind: GrantDeliveryKind,
  objectId: string,
  now: number,
): PrepareGrantResult {
  const accessor = checksumAccessor(grant.accessor);
  const dest = checksumAccessor(owner);
  if (!accessor || !dest) return { denied: true, reason: "bad-accessor" };
  const id = objectId.trim() || grant.claimId.trim();
  if (!id) return { denied: true, reason: "object" };
  const node: GunGrantTombstone = {
    retracted: 1,
    kind,
    objectId: id,
    owner: dest,
    accessor,
    ts: now,
    v: GUN_PROTOCOL_V,
  };
  return putTarget(kind, id, accessor, node);
}

export function isGrantTombstone(
  value: unknown,
): value is GunGrantTombstone {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (nodeHasForbiddenSecrets(record)) return false;
  if (protocolVersionOf(record.v) === null) return false;
  if (record.retracted !== 1) return false;
  const kind = grantDeliveryKindFromKey(String(record.kind ?? ""));
  return (
    kind !== undefined &&
    typeof record.objectId === "string" &&
    record.objectId.trim().length > 0 &&
    typeof record.owner === "string" &&
    typeof record.accessor === "string" &&
    typeof record.ts === "number" &&
    Number.isFinite(record.ts)
  );
}

export function fromGrantDeliveryNode(
  value: unknown,
): GunGrantDeliveryNode | null {
  if (!value || typeof value !== "object") return null;
  if (isGrantTombstone(value)) return null;
  const record = value as Record<string, unknown>;
  if (nodeHasForbiddenSecrets(record)) return null;
  if (protocolVersionOf(record.v) === null) return null;
  const kind = grantDeliveryKindFromKey(String(record.kind ?? ""));
  if (!kind) return null;
  if (typeof record.objectId !== "string" || !record.objectId.trim()) return null;
  if (typeof record.owner !== "string" || !record.owner.trim()) return null;
  if (typeof record.accessor !== "string" || !record.accessor.trim()) return null;
  if (typeof record.payload !== "string" || !record.payload.trim()) return null;
  if (typeof record.from !== "number" || !Number.isFinite(record.from)) return null;
  if (typeof record.until !== "number" || !Number.isFinite(record.until)) {
    return null;
  }
  if (record.from >= record.until) return null;
  const owner = checksumAccessor(record.owner);
  const accessor = checksumAccessor(record.accessor);
  if (!owner || !accessor) return null;
  return {
    kind,
    objectId: record.objectId.trim(),
    owner,
    accessor,
    from: record.from,
    until: record.until,
    payload: record.payload,
    ts: typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : 0,
    v: GUN_PROTOCOL_V,
  };
}

function decodeItemPayload(payload: string): FeedItem | null {
  const parsed = decodePayload(payload);
  if (!parsed) return null;
  const item = fromGunNode(parsed as Partial<GunFeedNode>);
  if (!item || !isGrantDeliverableItem(item)) return null;
  return item;
}

function decodeRoomPayload(payload: string): Room | null {
  const parsed = decodePayload(payload);
  if (!parsed) return null;
  return fromGunRoomNode(parsed as Partial<GunRoomNode>);
}

function decodeUserPayload(payload: string): User | null {
  const parsed = decodePayload(payload);
  if (!parsed) return null;
  if (userNodeHasForbiddenSecrets(parsed)) return null;
  return fromGunUserNode(parsed as Partial<GunUserNode> & Record<string, unknown>);
}

/**
 * Accessor: jointly state the received grant on the dest ACL, then
 * Check at now. Tombstones retract immediately. Does not write Public.
 */
export function acceptGrantDelivery(
  acl: SeeAcl,
  value: unknown,
  accessor: AccessorId,
  now: number,
): AcceptGrantResult {
  const who = checksumAccessor(accessor);
  if (!who) return { denied: true, reason: "bad-accessor" };

  if (isGrantTombstone(value)) {
    if (!sameAccessor(value.accessor, who)) {
      return { denied: true, reason: "accessor" };
    }
    cancelSee(acl, value.owner, who, value.objectId);
    const aliases = objectAliases(value.kind, value.objectId);
    for (const object of aliases) {
      cancelSee(acl, value.owner, who, object);
    }
    return { retracted: true, objectId: value.objectId, kind: value.kind };
  }

  const node = fromGrantDeliveryNode(value);
  if (!node) return { denied: true, reason: "node" };
  if (!sameAccessor(node.accessor, who)) {
    return { denied: true, reason: "accessor" };
  }
  const grant = deliveryGrant(node.objectId, node.accessor, node.from, node.until);
  if (!grantLiveAt(grant, now)) {
    return { denied: true, reason: now < grant.from ? "future-from" : "expired" };
  }

  if (node.kind === "item") {
    const item = decodeItemPayload(node.payload);
    if (!item || item.id !== node.objectId) {
      return { denied: true, reason: "payload" };
    }
    const object = itemSoul(item.id);
    acl.putObject(object, node.owner);
    acl.putObject(item.id, node.owner);
    applySeeGrant(acl, node.owner, grant);
    if (!checkSee(acl, object, who, now).allowed) {
      return { denied: true, reason: "check" };
    }
    return { kind: "item", item, grant, owner: node.owner };
  }

  if (node.kind === "room") {
    const room = decodeRoomPayload(node.payload);
    if (!room || room.id !== node.objectId) {
      return { denied: true, reason: "payload" };
    }
    const object = roomSoul(room.id);
    acl.putObject(object, node.owner);
    acl.putObject(room.id, node.owner);
    applySeeGrant(acl, node.owner, grant);
    if (!checkSee(acl, object, who, now).allowed) {
      return { denied: true, reason: "check" };
    }
    return { kind: "room", room, grant, owner: node.owner };
  }

  const user = decodeUserPayload(node.payload);
  if (!user) return { denied: true, reason: "payload" };
  const object = userSoul(user.id);
  acl.putObject(object, node.owner);
  acl.putObject(user.id, node.owner);
  acl.putObject(node.objectId, node.owner);
  for (const claim of user.indicators) {
    acl.putObject(claim, node.owner);
  }
  applySeeGrant(acl, node.owner, grant);
  const checked = acl.hasObject(node.objectId)
    ? checkSee(acl, node.objectId, who, now)
    : checkSee(acl, object, who, now);
  if (!checked.allowed) return { denied: true, reason: "check" };
  return { kind: "user", user, grant, owner: node.owner };
}

function objectAliases(
  kind: GrantDeliveryKind,
  objectId: string,
): CheckObjectId[] {
  if (kind === "item") return [itemSoul(objectId)];
  if (kind === "room") return [roomSoul(objectId)];
  const user = userObjectId(objectId);
  return user ? [user] : [];
}

export type GrantGunRef = {
  get: (key: string) => GrantGunRef;
  put: (data: unknown) => GrantGunRef;
  map?: () => {
    on: (cb: (data: unknown, key: string) => void) => { off?: () => void };
  };
};

/** Client put helper. Azure is not a delivery server. */
export function putGrantDelivery(gun: GrantGunRef, target: GrantPutTarget): void {
  gun
    .get(S3RCH_ROOT)
    .get(S3RCH_GRANTED)
    .get(target.accessorKey)
    .get(target.kindKey)
    .get(target.objectKey)
    .put(target.node);
}

export function grantInboxRef(
  gun: GrantGunRef,
  accessor: string,
  kind: GrantInboxKind,
): GrantGunRef | null {
  const accessorKey = checksumAccessor(accessor);
  if (!accessorKey) return null;
  return gun.get(S3RCH_ROOT).get(S3RCH_GRANTED).get(accessorKey).get(kind);
}
