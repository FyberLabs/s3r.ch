/**
 * Tags-first, then recency. No engagement, no Popular / Novel columns.
 *
 * Selected tags: any-match filter (same as TagChips). Higher matching-tag
 * count first, then ts desc. No tags selected: ts desc only.
 */

import type { FeedItem } from "./feed-types";

export function rankFeedItems(
  items: readonly FeedItem[],
  selectedTags: readonly string[],
): FeedItem[] {
  const selected = selectedTags
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  const filtered =
    selected.length === 0
      ? items.slice()
      : items.filter((item) =>
          item.tags.some((tag) => selected.includes(tag)),
        );

  return filtered.sort((a, b) => {
    if (selected.length > 0) {
      const diff = matchCount(b, selected) - matchCount(a, selected);
      if (diff !== 0) return diff;
    }
    return (b.ts || 0) - (a.ts || 0) || a.id.localeCompare(b.id);
  });
}

function matchCount(item: FeedItem, selected: string[]): number {
  return item.tags.filter((tag) => selected.includes(tag)).length;
}
