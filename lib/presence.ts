/**
 * Gun-native room presence. A heartbeat is a SociACL object on
 * s3rch/rooms/<encodeKey(room)>/presence/<encodeKey(address)>.
 * Mine-only rooms keep presence on the overlay. Put onto the shared
 * room path only when that room node is already on s3rch/rooms.
 * Sharing a room is not sharing Mine posts inside it.
 * Do not put SIWE signatures, SEA keys, or held claims on the node.
 */

import { getAddress } from "viem";
import { GUN_PROTOCOL_V, protocolVersionOf } from "./feed-types";
import {
  admitPresenceNode,
  encodeKey,
  type GunPresenceNode,
  type SeeAcl,
} from "./identity/check";

export type { GunPresenceNode };

/** Heartbeat cadence while a room is open (~20–30s). */
export const PRESENCE_HEARTBEAT_MS = 25_000;

/** Soft TTL. A row with no heartbeat in this window is gone (~60–90s). */
export const PRESENCE_TTL_SECONDS = 75;

export type PresenceEntry = {
  room: string;
  address: string;
  ts: number;
  v?: number;
};

export type ComposePresenceInput = {
  roomId: string;
  address: string;
  nowSeconds?: number;
};

export type AdmitPresenceResult =
  | { entry: PresenceEntry; object: string }
  | { denied: true };

export type PutRoomPresenceResult =
  | { node: GunPresenceNode; roomKey: string; key: string }
  | { denied: true };

export function toGunPresenceNode(entry: PresenceEntry): GunPresenceNode {
  return {
    room: entry.room,
    address: entry.address,
    ts: entry.ts,
    v: entry.v ?? GUN_PROTOCOL_V,
  };
}

export function fromGunPresenceNode(
  node: Partial<GunPresenceNode> | null | undefined,
): PresenceEntry | null {
  if (!node || typeof node.room !== "string" || !node.room.trim()) {
    return null;
  }
  let address = typeof node.address === "string" ? node.address.trim() : "";
  if (!address) return null;
  try {
    address = getAddress(address);
  } catch {
    return null;
  }
  const v = protocolVersionOf(node.v);
  if (v === null) return null;
  if (typeof node.ts !== "number" || !Number.isFinite(node.ts)) return null;
  return {
    room: node.room.trim(),
    address,
    ts: node.ts,
    v,
  };
}

/**
 * Build a presence heartbeat. Author is the checksummed session address.
 * Empty room or a bad address is rejected.
 */
export function composePresence(input: ComposePresenceInput): PresenceEntry | null {
  const room = input.roomId.trim();
  if (!room) return null;

  let address: string;
  try {
    address = getAddress(input.address);
  } catch {
    return null;
  }

  const ts =
    typeof input.nowSeconds === "number" && Number.isFinite(input.nowSeconds)
      ? Math.floor(input.nowSeconds)
      : Math.floor(Date.now() / 1000);

  return {
    room,
    address,
    ts,
    v: GUN_PROTOCOL_V,
  };
}

/**
 * Stale heartbeat so readers drop this address immediately.
 * Used on leave / unmount / tab hide. Still a valid v1 node.
 */
export function composePresenceLeave(
  input: ComposePresenceInput,
): PresenceEntry | null {
  const now =
    typeof input.nowSeconds === "number" && Number.isFinite(input.nowSeconds)
      ? Math.floor(input.nowSeconds)
      : Math.floor(Date.now() / 1000);
  return composePresence({
    ...input,
    nowSeconds: now - PRESENCE_TTL_SECONDS,
  });
}

/** Dest re-auth before overlay register or Gun put. Hint / URL fetch is not authorization. */
export function admitComposedPresence(
  acl: SeeAcl,
  entry: PresenceEntry,
  owner: string,
): AdmitPresenceResult {
  const admitted = admitPresenceNode(acl, toGunPresenceNode(entry), owner);
  if ("denied" in admitted) return { denied: true };
  return { entry, object: admitted.object };
}

/**
 * Admit, then return the Gun put keys for
 * gun.get('s3rch').get('rooms').get(roomKey).get('presence').get(key).
 * Does not grant see. Does not decide Mine vs public — use
 * preparePublishRoomPresence so Mine-only presence stays off s3rch/rooms.
 */
export function preparePutRoomPresence(
  acl: SeeAcl,
  entry: PresenceEntry,
  owner: string,
): PutRoomPresenceResult {
  const admitted = admitComposedPresence(acl, entry, owner);
  if ("denied" in admitted) return { denied: true };
  return {
    node: toGunPresenceNode(entry),
    roomKey: encodeKey(entry.room),
    key: encodeKey(entry.address),
  };
}

/** True when this room node is already on the public s3rch/rooms graph. */
export function roomPresenceOnPublicGraph(
  roomId: string,
  publicRoomIds: Iterable<string>,
): boolean {
  const id = roomId.trim();
  if (!id) return false;
  for (const row of publicRoomIds) {
    if (row === id) return true;
  }
  return false;
}

/**
 * Put onto the shared room presence path only when that room is already public.
 * Do not dump Mine-only room presence onto s3rch/rooms.
 */
export function preparePublishRoomPresence(
  acl: SeeAcl,
  entry: PresenceEntry,
  owner: string,
  publicRoomIds: Iterable<string>,
): PutRoomPresenceResult {
  if (!roomPresenceOnPublicGraph(entry.room, publicRoomIds)) {
    return { denied: true };
  }
  return preparePutRoomPresence(acl, entry, owner);
}

export function isPresenceLive(
  entry: PresenceEntry,
  nowSeconds: number,
  ttlSeconds: number = PRESENCE_TTL_SECONDS,
): boolean {
  return entry.ts + ttlSeconds > nowSeconds;
}

export function presenceInRoom(
  entries: readonly PresenceEntry[],
  roomId: string,
): PresenceEntry[] {
  const id = roomId.trim();
  if (!id) return [];
  return entries.filter((row) => row.room === id);
}

/** Live rows only, address then recency. Same address keeps the newest ts. */
export function livePresence(
  entries: readonly PresenceEntry[],
  nowSeconds: number,
  ttlSeconds: number = PRESENCE_TTL_SECONDS,
): PresenceEntry[] {
  return rankPresence(
    entries.filter((row) => isPresenceLive(row, nowSeconds, ttlSeconds)),
  );
}

/** Address then recency (ts desc). */
export function rankPresence(entries: readonly PresenceEntry[]): PresenceEntry[] {
  return entries.slice().sort(
    (a, b) =>
      a.address.localeCompare(b.address) || (b.ts || 0) - (a.ts || 0),
  );
}

/**
 * Latest ts per room+address wins (heartbeats replace). Unlike chat,
 * first-seen would freeze the TTL.
 */
export function mergePresence(
  seed: readonly PresenceEntry[],
  overlay: readonly PresenceEntry[],
): PresenceEntry[] {
  const byKey = new Map<string, PresenceEntry>();
  for (const row of [...seed, ...overlay]) {
    if (!row.room || !row.address) continue;
    const key = `${row.room}\0${row.address}`;
    const prev = byKey.get(key);
    if (!prev || row.ts > prev.ts) {
      byKey.set(key, row);
    }
  }
  return rankPresence(Array.from(byKey.values()));
}

/** Short checksummed address. Held claims stay local — never on the Gun node. */
export function shortPresenceAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Display label. Prefer a locally known held claim (already fetched, not
 * a new login). Never write that claim onto the presence node.
 */
export function presenceDisplayName(
  address: string,
  knownClaim?: string | null,
): string {
  const claim = knownClaim?.trim();
  if (claim) return claim;
  return shortPresenceAddress(address);
}
