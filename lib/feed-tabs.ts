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
  "Network is empty until a live connection comes up.";

export const GRANTED_NEEDS_PEER_COPY =
  "Granted is empty until a live connection comes up.";

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
      ? "No posts in this room for these tags."
      : "No posts in this room yet.";
  }
  if (!opts.seedWsUp && !opts.hasMeshRows) {
    return NETWORK_NEEDS_PEER_COPY;
  }
  return opts.tagged
    ? "No posts for these tags."
    : "Nothing on the network yet.";
}

export function emptyGrantedCopy(opts: {
  signedIn: boolean;
  tagged: boolean;
  inRoom: boolean;
  seedWsUp: boolean;
  hasGrantedRows: boolean;
}): string {
  if (!opts.signedIn) {
    return "Sign in to see posts shared with you.";
  }
  if (opts.inRoom) {
    return opts.tagged
      ? "No posts in this room for these tags."
      : "No posts in this room yet.";
  }
  if (!opts.seedWsUp && !opts.hasGrantedRows) {
    return GRANTED_NEEDS_PEER_COPY;
  }
  return opts.tagged
    ? "No posts for these tags."
    : "Nothing shared with you yet.";
}
