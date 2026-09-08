/**
 * Public = seed (Gun snapshot / shared native posts).
 * Mine = overlay (ingest + native posts). Unshared native stays mine.
 * Network = live Gun mesh (`s3rch/items` via `.map().on`), not snapshot
 * hydrate and not Mine overlay / ingest.
 * Discover (`lib/feed-discover.ts`) uses Public + Network only — never Mine.
 */

import type { FeedItem, FeedTab } from "./feed-types";

export const NETWORK_NEEDS_PEER_COPY =
  "Network needs the seed peer or WebRTC; Public still has the snapshot";

export function itemsForTab(
  tab: FeedTab,
  seed: readonly FeedItem[],
  overlay: readonly FeedItem[],
  mesh: readonly FeedItem[] = [],
): FeedItem[] {
  if (tab === "mine") return overlay.slice();
  if (tab === "public") return seed.slice();
  if (tab === "network") return mesh.slice();
  return [];
}

/**
 * Accept a Gun `.map().on` row into the Network set only while the
 * same-origin `/gun` seed peer is up (WebRTC is additive when ICE works).
 * Keep already-seen mesh rows after a brief bye.
 */
export function acceptLiveMeshWrite(seedWsUp: boolean): boolean {
  return seedWsUp;
}

export function emptyNetworkCopy(opts: {
  tagged: boolean;
  inRoom: boolean;
  seedWsUp: boolean;
  hasMeshRows: boolean;
}): string {
  if (opts.inRoom) {
    return opts.tagged
      ? "No live mesh posts in this room for the selected tags."
      : "This shared room has no live mesh posts yet. Sharing the room does not publish Mine posts.";
  }
  if (!opts.seedWsUp && !opts.hasMeshRows) {
    return NETWORK_NEEDS_PEER_COPY;
  }
  return opts.tagged
    ? "No live mesh items for the selected tags."
    : "The live mesh has no items yet. Public still has the snapshot if the seeder wrote any.";
}
