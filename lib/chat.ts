/**
 * Gun-native room chat. A message is a SociACL object on
 * s3rch/rooms/<encodeKey(room)>/chat/<encodeKey(id)>.
 * Mine-only rooms keep chat on the overlay. Put onto the shared
 * room path only when that room node is already on s3rch/rooms.
 * Sharing a room is not sharing Mine posts inside it.
 */

import { getAddress } from "viem";
import { GUN_PROTOCOL_V, protocolVersionOf } from "./feed-types";
import {
  admitChatNode,
  encodeKey,
  type GunChatNode,
  type SeeAcl,
} from "./identity/check";

export type { GunChatNode };

export const CHAT_BODY_MAX = 280;

export type ChatMessage = {
  id: string;
  room: string;
  author: string;
  body: string;
  ts: number;
  v?: number;
};

export type ComposeChatInput = {
  body: string;
  roomId: string;
  address: string;
  nowSeconds?: number;
  entropy?: string;
};

export type AdmitChatResult =
  | { message: ChatMessage; object: string }
  | { denied: true };

export type PutRoomChatResult =
  | { node: GunChatNode; roomKey: string; key: string }
  | { denied: true };

/** encodeKey-safe short entropy (hex). */
export function shortChatEntropy(bytes = 4): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function encodeKeySafe(value: string): string {
  return value.replace(/[.#$[\]]/g, "");
}

export function toGunChatNode(message: ChatMessage): GunChatNode {
  return {
    id: message.id,
    room: message.room,
    author: message.author,
    body: message.body,
    ts: message.ts,
    v: message.v ?? GUN_PROTOCOL_V,
  };
}

export function fromGunChatNode(
  node: Partial<GunChatNode> | null | undefined,
): ChatMessage | null {
  if (!node || typeof node.id !== "string" || !node.id.trim()) {
    return null;
  }
  const room = typeof node.room === "string" ? node.room.trim() : "";
  if (!room) return null;
  const body = typeof node.body === "string" ? node.body.trim() : "";
  if (!body) return null;
  let author = typeof node.author === "string" ? node.author.trim() : "";
  if (!author) return null;
  try {
    author = getAddress(author);
  } catch {
    return null;
  }
  const v = protocolVersionOf(node.v);
  if (v === null) return null;
  return {
    id: node.id.trim(),
    room,
    author,
    body,
    ts: typeof node.ts === "number" && Number.isFinite(node.ts) ? node.ts : 0,
    v,
  };
}

/**
 * Build a short chat message. Empty / whitespace body is rejected.
 * Body is capped. Author is the checksummed session address.
 */
export function composeChat(input: ComposeChatInput): ChatMessage | null {
  const body = input.body.trim();
  if (!body || body.length > CHAT_BODY_MAX) return null;
  const room = input.roomId.trim();
  if (!room) return null;

  let author: string;
  try {
    author = getAddress(input.address);
  } catch {
    return null;
  }

  const ts =
    typeof input.nowSeconds === "number" && Number.isFinite(input.nowSeconds)
      ? Math.floor(input.nowSeconds)
      : Math.floor(Date.now() / 1000);
  const entropy = encodeKeySafe((input.entropy ?? shortChatEntropy()).trim());
  if (!entropy) return null;

  return {
    id: `s3rch:chat:${author}:${ts}:${entropy}`,
    room,
    author,
    body,
    ts,
    v: GUN_PROTOCOL_V,
  };
}

/** Dest re-auth before overlay register or Gun put. Hint / URL fetch is not authorization. */
export function admitComposedChat(
  acl: SeeAcl,
  message: ChatMessage,
  owner: string,
): AdmitChatResult {
  const admitted = admitChatNode(acl, toGunChatNode(message), owner);
  if ("denied" in admitted) return { denied: true };
  return { message, object: admitted.object };
}

/**
 * Admit, then return the Gun put keys for
 * gun.get('s3rch').get('rooms').get(roomKey).get('chat').get(key).
 * Does not grant see. Does not decide Mine vs public — use
 * preparePublishRoomChat so Mine-only chat stays off s3rch/rooms.
 */
export function preparePutRoomChat(
  acl: SeeAcl,
  message: ChatMessage,
  owner: string,
): PutRoomChatResult {
  const admitted = admitComposedChat(acl, message, owner);
  if ("denied" in admitted) return { denied: true };
  return {
    node: toGunChatNode(message),
    roomKey: encodeKey(message.room),
    key: encodeKey(message.id),
  };
}

/** True when this room node is already on the public s3rch/rooms graph. */
export function roomChatOnPublicGraph(
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
 * Put onto the shared room chat path only when that room is already public.
 * Do not dump Mine-only room chat onto s3rch/rooms.
 */
export function preparePublishRoomChat(
  acl: SeeAcl,
  message: ChatMessage,
  owner: string,
  publicRoomIds: Iterable<string>,
): PutRoomChatResult {
  if (!roomChatOnPublicGraph(message.room, publicRoomIds)) {
    return { denied: true };
  }
  return preparePutRoomChat(acl, message, owner);
}

export function messagesInRoom(
  messages: readonly ChatMessage[],
  roomId: string,
): ChatMessage[] {
  const id = roomId.trim();
  if (!id) return [];
  return messages.filter((row) => row.room === id);
}

/** Recency (ts desc), then id. Same idea as rankRooms. */
export function rankChatMessages(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  return messages.slice().sort(
    (a, b) => (b.ts || 0) - (a.ts || 0) || a.id.localeCompare(b.id),
  );
}

export function mergeChat(
  seed: readonly ChatMessage[],
  overlay: readonly ChatMessage[],
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const row of [...seed, ...overlay]) {
    if (!row.id || byId.has(row.id)) continue;
    byId.set(row.id, row);
  }
  return rankChatMessages(Array.from(byId.values()));
}
