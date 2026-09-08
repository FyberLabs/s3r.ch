/**
 * Client-side Discover over items/rooms already in Public (seed + shared)
 * and the live Network mesh (`meshItems` / `meshRooms` from Gun `.map().on`).
 *
 * Not a search API. Not Popular / Novel. Counts are inventory — how many
 * items and rooms already carry the tag — not an engagement score.
 * Mine overlay and the Granted inbox are never Discover sources. Same
 * TagChips any-match ranker (`rankFeedItems` / `rankRooms`).
 */

import { mergeItems } from "./merge";
import { mergeRooms, type Room } from "./rooms";
import { normalizeTags, type FeedItem } from "./feed-types";

export type DiscoverTag = {
  tag: string;
  itemCount: number;
  roomCount: number;
};

export type DiscoverCorpus = {
  items: FeedItem[];
  rooms: Room[];
};

export type DiscoverSources = {
  publicItems: readonly FeedItem[];
  publicRooms: readonly Room[];
  networkItems?: readonly FeedItem[];
  networkRooms?: readonly Room[];
};

/**
 * Public seed + shared rooms, plus the live Network mesh.
 * Callers must not pass Mine overlay / unshared native rows.
 */
export function discoverCorpus(sources: DiscoverSources): DiscoverCorpus {
  return {
    items: mergeItems(
      sources.publicItems.slice(),
      (sources.networkItems ?? []).slice(),
    ),
    rooms: mergeRooms(sources.publicRooms, sources.networkRooms ?? []),
  };
}

/**
 * Every tag already on the corpus, with item/room inventory.
 * Alphabetical — not sorted by count (that would look like Popular).
 */
export function aggregateDiscoverTags(
  items: readonly FeedItem[],
  rooms: readonly Room[],
): DiscoverTag[] {
  const itemCounts = new Map<string, number>();
  const roomCounts = new Map<string, number>();

  for (const item of items) {
    for (const tag of item.tags) {
      itemCounts.set(tag, (itemCounts.get(tag) ?? 0) + 1);
    }
  }
  for (const room of rooms) {
    for (const tag of room.tags) {
      roomCounts.set(tag, (roomCounts.get(tag) ?? 0) + 1);
    }
  }

  const tags = new Set<string>([...itemCounts.keys(), ...roomCounts.keys()]);
  return Array.from(tags)
    .sort((a, b) => a.localeCompare(b))
    .map((tag) => ({
      tag,
      itemCount: itemCounts.get(tag) ?? 0,
      roomCount: roomCounts.get(tag) ?? 0,
    }));
}

export function discoverTagCounts(
  tags: readonly DiscoverTag[],
): Record<string, { items: number; rooms: number }> {
  const counts: Record<string, { items: number; rooms: number }> = {};
  for (const row of tags) {
    counts[row.tag] = { items: row.itemCount, rooms: row.roomCount };
  }
  return counts;
}

/** `/feed?tag=social,mesh` — comma list, same normalizeTags as writers. */
export function parseDiscoverTagQuery(
  value: string | null | undefined,
): string[] {
  if (!value) return [];
  return normalizeTags(value.split(","));
}

export function formatDiscoverTagQuery(tags: readonly string[]): string {
  return normalizeTags([...tags]).join(",");
}

/** Room owner snippet. Provenance, not a user profile. */
export function shortenOwner(owner: string): string {
  if (owner.length < 12) return owner;
  return `${owner.slice(0, 6)}…${owner.slice(-4)}`;
}
