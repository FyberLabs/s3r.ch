/**
 * Public = seed (Gun snapshot / shared native posts).
 * Mine = overlay (ingest + native posts). Unshared native stays mine.
 * Network is later — mesh. Empty until that slice.
 */

import type { FeedItem, FeedTab } from "./feed-types";

export function itemsForTab(
  tab: FeedTab,
  seed: readonly FeedItem[],
  overlay: readonly FeedItem[],
): FeedItem[] {
  if (tab === "mine") return overlay.slice();
  if (tab === "public") return seed.slice();
  return [];
}
