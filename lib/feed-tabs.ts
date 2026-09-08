/**
 * Public = seed (Gun snapshot / shared native posts).
 * Mine = overlay (ingest + native posts). Unshared native stays mine.
 * Network = live Gun mesh (`s3rch/items` via `.map().on`), not snapshot
 * hydrate and not Mine overlay / ingest.
 * Granted = live grant-delivery inbox (`s3rch/granted/<accessor>/…`).
 * Not Public, not Network, not Discover.
 * Discover (`lib/feed-discover.ts`) uses Public + Network only — never Mine
 * or Granted.
 */

import type { FeedItem, FeedTab } from "./feed-types";

export const NETWORK_NEEDS_PEER_COPY =
  "Network needs the seed peer or WebRTC; Public still has the snapshot";

export const GRANTED_NEEDS_PEER_COPY =
  "Granted needs the seed peer or WebRTC; revoke is still immediate on the dest ACL";

export function itemsForTab(
  tab: FeedTab,
  seed: readonly FeedItem[],
  overlay: readonly FeedItem[],
  mesh: readonly FeedItem[] = [],
  granted: readonly FeedItem[] = [],
): FeedItem[] {
  if (tab === "mine") return overlay.slice();
  if (tab === "public") return seed.slice();
  if (tab === "network") return mesh.slice();
  if (tab === "granted") return granted.slice();
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

export function emptyGrantedCopy(opts: {
  signedIn: boolean;
  tagged: boolean;
  inRoom: boolean;
  seedWsUp: boolean;
  hasGrantedRows: boolean;
}): string {
  if (!opts.signedIn) {
    return "Granted is empty until you sign in. A see-grant delivers Gun-stored objects here — not Public, not search.";
  }
  if (opts.inRoom) {
    return opts.tagged
      ? "No granted posts in this room for the selected tags."
      : "This granted room has no delivered posts yet. Granting a room does not deliver Mine posts inside it.";
  }
  if (!opts.seedWsUp && !opts.hasGrantedRows) {
    return GRANTED_NEEDS_PEER_COPY;
  }
  return opts.tagged
    ? "No granted items for the selected tags."
    : "No granted Gun objects yet. First delivery can wait on the mesh. URL fetches stay handoffs.";
}
