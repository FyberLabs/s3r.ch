/**
 * Source adapters for Views: build a SourceRef from an existing s3r.ch room, forum
 * channel or pulled feed, and map that source's messages to one row shape.
 * See docs/views.md §2 and §10 (PR 1).
 */
import type { ChatMessage } from "./chat";
import type { FeedItem } from "./feed-types";
import type { ForumChannel, ForumMessage } from "./forum";
import type { GunRoomNode } from "./identity/check";
import { formatCanonical, validateSourceRef, type Result, type SourceRef } from "./views-source-ref";

/** One message, post or item from any source, as a View window renders it. */
export type ViewRow = {
  /** Unique across sources: canonical SourceRef + "#" + item id. */
  key: string;
  source: SourceRef;
  id: string;
  author: string;
  body: string;
  /** Unix seconds, as stored by the source. */
  ts: number;
  permalink?: string;
};

function makeRef(input: Omit<SourceRef, "v">): Result<SourceRef> {
  return validateSourceRef({ ...input, v: 1 });
}

function nativeOnly(network: string): Result<SourceRef> | null {
  return network.startsWith("s3rch:") ? null : { ok: false, error: "rooms and forum channels exist only on s3r.ch networks" };
}

/** A native room on an s3r.ch network is a chat source owned by the room owner. */
export function roomSourceRef(network: string, room: Pick<GunRoomNode, "id" | "owner">): Result<SourceRef> {
  return nativeOnly(network) ?? makeRef({ network, owner: room.owner, source: room.id, kind: "chat" });
}

/** A forum channel on an s3r.ch network. */
export function forumSourceRef(network: string, channel: Pick<ForumChannel, "id" | "owner">): Result<SourceRef> {
  return nativeOnly(network) ?? makeRef({ network, owner: channel.owner, source: channel.id, kind: "forum" });
}

/**
 * A feed. `owner` is the stable identifier for the feed's network (DID, FID, hex pubkey,
 * actor id or feed origin; for s3r.ch, the wallet); `feed` is the provider-local feed id.
 */
export function feedSourceRef(network: string, owner: string, feed: string): Result<SourceRef> {
  return makeRef({ network, owner, source: feed, kind: "feed" });
}

function validTs(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && ts >= 0;
}

function row(ref: SourceRef, id: string, author: string, body: string, ts: number, permalink?: string): ViewRow | null {
  if (typeof id !== "string" || id === "" || typeof author !== "string" || typeof body !== "string" || !validTs(ts)) {
    return null;
  }
  const out: ViewRow = { key: `${formatCanonical(ref)}#${id}`, source: ref, id, author, body, ts };
  if (permalink) out.permalink = permalink;
  return out;
}

/** Chat message → row. Returns null if the message is not from this room or is malformed. */
export function chatRow(ref: SourceRef, message: ChatMessage): ViewRow | null {
  if (ref.kind !== "chat" || message.room !== ref.source) return null;
  return row(ref, message.id, message.author, message.body, message.ts);
}

/** Forum message → row. The author shown is the posting bot. */
export function forumRow(ref: SourceRef, message: ForumMessage): ViewRow | null {
  if (ref.kind !== "forum" || message.channel !== ref.source) return null;
  return row(ref, message.id, message.bot, message.body, message.ts);
}

/** Feed item → row. The caller is responsible for having selected items that belong to this feed. */
export function feedRow(ref: SourceRef, item: FeedItem): ViewRow | null {
  if (ref.kind !== "feed") return null;
  return row(ref, item.id, item.author, item.body, item.ts, item.permalink || undefined);
}
