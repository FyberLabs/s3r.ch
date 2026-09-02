/**
 * Gun-native rooms. A room is a SociACL object on s3rch/rooms.
 * Posts belong by tag (`room:{slug}`), same FeedItem / GunFeedNode shape.
 * Default visibility is mine. Share-into-mesh is a separate explicit put
 * of the room node only — it does not publish Mine posts inside the room.
 */

import { getAddress } from "viem";
import { composeNativePost, type ComposeNativeInput } from "./compose";
import {
  GUN_PROTOCOL_V,
  normalizeTags,
  protocolVersionOf,
  splitTags,
  type FeedItem,
  type FeedTab,
} from "./feed-types";
import {
  admitRoomNode,
  encodeKey,
  type GunRoomNode,
  type SeeAcl,
} from "./identity/check";

export type { GunRoomNode };

export const ROOM_KIND_TAGS = ["room", "s3rch"] as const;
export const ROOM_TITLE_MAX = 80;

export type Room = {
  id: string;
  title: string;
  owner: string;
  tags: string[];
  ts: number;
  provenance: string;
  v?: number;
};

export type ComposeRoomInput = {
  title: string;
  address: string;
  tags?: string[];
  nowSeconds?: number;
  entropy?: string;
};

export type AdmitRoomResult =
  | { room: Room; object: string }
  | { denied: true };

export type ShareRoomResult =
  | { node: GunRoomNode; key: string }
  | { denied: true };

/** encodeKey-safe short entropy (hex). */
export function shortRoomEntropy(bytes = 4): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function encodeKeySafe(value: string): string {
  return value.replace(/[.#$[\]]/g, "");
}

/**
 * Stable membership tag for posts in this room.
 * Lowercased so it matches normalizeTags on FeedItem.tags.
 */
export function roomTag(id: string): string {
  return `room:${encodeKey(id)}`.toLowerCase();
}

export function toGunRoomNode(room: Room): GunRoomNode {
  return {
    id: room.id,
    title: room.title,
    owner: room.owner,
    tags: room.tags.join(","),
    ts: room.ts,
    provenance: room.provenance,
    v: room.v ?? GUN_PROTOCOL_V,
  };
}

export function fromGunRoomNode(
  node: Partial<GunRoomNode> | null | undefined,
): Room | null {
  if (!node || typeof node.id !== "string" || !node.id.trim()) {
    return null;
  }
  const title = typeof node.title === "string" ? node.title.trim() : "";
  if (!title) return null;
  let owner = typeof node.owner === "string" ? node.owner.trim() : "";
  if (!owner) return null;
  try {
    owner = getAddress(owner);
  } catch {
    return null;
  }
  const v = protocolVersionOf(node.v);
  if (v === null) return null;
  return {
    id: node.id.trim(),
    title,
    owner,
    tags: splitTags(node.tags),
    ts: typeof node.ts === "number" && Number.isFinite(node.ts) ? node.ts : 0,
    provenance: typeof node.provenance === "string" ? node.provenance.trim() : "",
    v,
  };
}

/**
 * Build a room. Empty / whitespace title is rejected. Title is short.
 * Tags always include `room` and `s3rch`.
 */
export function composeRoom(input: ComposeRoomInput): Room | null {
  const title = input.title.trim();
  if (!title || title.length > ROOM_TITLE_MAX) return null;

  let owner: string;
  try {
    owner = getAddress(input.address);
  } catch {
    return null;
  }

  const ts =
    typeof input.nowSeconds === "number" && Number.isFinite(input.nowSeconds)
      ? Math.floor(input.nowSeconds)
      : Math.floor(Date.now() / 1000);
  const entropy = encodeKeySafe((input.entropy ?? shortRoomEntropy()).trim());
  if (!entropy) return null;

  const id = `s3rch:room:${owner}:${ts}:${entropy}`;
  return {
    id,
    title,
    owner,
    tags: normalizeTags([...(input.tags ?? []), ...ROOM_KIND_TAGS]),
    ts,
    provenance: `s3rch:room:${owner}`,
    v: GUN_PROTOCOL_V,
  };
}

/** Dest re-auth before overlay register. Hint / URL fetch is not authorization. */
export function admitComposedRoom(
  acl: SeeAcl,
  room: Room,
  owner: string,
): AdmitRoomResult {
  const admitted = admitRoomNode(acl, toGunRoomNode(room), owner);
  if ("denied" in admitted) return { denied: true };
  return { room, object: admitted.object };
}

/**
 * Prepare an explicit share of the room node onto s3rch/rooms.
 * Does not grant see. Does not share posts inside the room.
 */
export function prepareShareRoomIntoMesh(
  acl: SeeAcl,
  room: Room,
  owner: string,
): ShareRoomResult {
  const admitted = admitComposedRoom(acl, room, owner);
  if ("denied" in admitted) return { denied: true };
  return { node: toGunRoomNode(room), key: encodeKey(room.id) };
}

export function ownsRoom(
  room: Pick<Room, "owner">,
  address: string | null | undefined,
): boolean {
  if (!address) return false;
  try {
    return getAddress(room.owner) === getAddress(address);
  } catch {
    return false;
  }
}

export function ownedRooms(
  rooms: readonly Room[],
  address: string | null | undefined,
): Room[] {
  return rooms.filter((room) => ownsRoom(room, address));
}

/**
 * Public = rooms explicitly put onto s3rch/rooms.
 * Mine = owned overlay rooms. Network is later — empty.
 */
export function roomsForTab(
  tab: FeedTab,
  publicRooms: readonly Room[],
  mineRooms: readonly Room[],
): Room[] {
  if (tab === "mine") return mineRooms.slice();
  if (tab === "public") return publicRooms.slice();
  return [];
}

/** Posts whose tags include this room's membership tag. */
export function itemsInRoom(
  items: readonly FeedItem[],
  roomId: string,
): FeedItem[] {
  const tag = roomTag(roomId);
  return items.filter((item) => item.tags.includes(tag));
}

/** Tags-first, then recency. Same idea as rankFeedItems. */
export function rankRooms(
  rooms: readonly Room[],
  selectedTags: readonly string[],
): Room[] {
  const selected = selectedTags
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  const filtered =
    selected.length === 0
      ? rooms.slice()
      : rooms.filter((room) =>
          room.tags.some((tag) => selected.includes(tag)),
        );

  return filtered.sort((a, b) => {
    if (selected.length > 0) {
      const diff = matchCount(b, selected) - matchCount(a, selected);
      if (diff !== 0) return diff;
    }
    return (b.ts || 0) - (a.ts || 0) || a.id.localeCompare(b.id);
  });
}

function matchCount(room: Room, selected: string[]): number {
  return room.tags.filter((tag) => selected.includes(tag)).length;
}

export function mergeRooms(seed: readonly Room[], overlay: readonly Room[]): Room[] {
  const byId = new Map<string, Room>();
  for (const room of [...seed, ...overlay]) {
    if (!room.id || byId.has(room.id)) continue;
    byId.set(room.id, room);
  }
  return Array.from(byId.values()).sort(
    (a, b) => (b.ts || 0) - (a.ts || 0) || a.id.localeCompare(b.id),
  );
}

/** Native compose into a room: existing post plus the room membership tag. */
export function composeNativePostInRoom(
  input: ComposeNativeInput & { roomId: string },
): FeedItem | null {
  const membership = roomTag(input.roomId);
  if (!membership || membership === "room:") return null;
  return composeNativePost({
    ...input,
    tags: [...(input.tags ?? []), membership],
  });
}
