import type { FeedItem } from "./feed-types";

export function canonicalKey(item: Pick<FeedItem, "id" | "permalink">): string {
  const id = item.id.trim();
  if (id) return id;
  return normalizePermalink(item.permalink);
}

export function normalizePermalink(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return trimmed;
  }
}

/**
 * Merge overlay items onto a public seed. Same shape, provenance preserved,
 * dedupe by canonical id / permalink. First-seen wins (public seed first).
 */
export function mergeItems(seed: FeedItem[], overlay: FeedItem[]): FeedItem[] {
  const byKey = new Map<string, FeedItem>();
  for (const item of [...seed, ...overlay]) {
    const key = canonicalKey(item);
    if (!key) continue;
    if (!byKey.has(key)) {
      byKey.set(key, item);
      continue;
    }
    const existing = byKey.get(key)!;
    const permalink = existing.permalink || item.permalink;
    const tags = Array.from(new Set([...existing.tags, ...item.tags]));
    byKey.set(key, { ...existing, permalink, tags });
  }
  return Array.from(byKey.values()).sort((a, b) => (b.ts || 0) - (a.ts || 0) || a.id.localeCompare(b.id));
}
