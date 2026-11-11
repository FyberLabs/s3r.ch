import type { FeedItem, FeedSource, SourcePull } from "./feed-types";
import { canonicalKey } from "./merge";

/** Each fulfilled operation is one complete response window, never a partial stream. */
export async function collectSourceWindows(
  sources: { key: string; pull: () => Promise<FeedItem[]> }[],
  classes: FeedSource[],
  failure: string,
): Promise<SourcePull> {
  const results = await Promise.allSettled(sources.map(source => Promise.resolve().then(source.pull)));
  const windows = results.flatMap((result, i) => result.status === "fulfilled"
    ? [{ key: sources[i].key, items: result.value }] : []);
  const items = new Map<string, FeedItem>();
  for (const window of windows) for (const item of window.items) {
    const key = canonicalKey(item);
    if (key && !items.has(key)) items.set(key, { ...item, id: key });
  }
  const rejected = results.find(result => result.status === "rejected");
  return {
    items: [...items.values()], windows,
    completeSources: sources.length > 0 && windows.length === sources.length ? classes : [],
    sourcesOk: windows.length, sourcesTried: sources.length,
    error: windows.length ? null : `${failure} This feed does not invent rows. ${rejected?.reason instanceof Error ? rejected.reason.message : "All requests failed."}`,
  };
}

export type SourceCache = {
  items: Map<string, FeedItem>;
  windows: Map<string, string[]>;
  retired: Set<string>;
};

/** Compute a new cache before touching durable state or the shared graph. */
export function reconcileSourceWindows(previous: SourceCache, pull: SourcePull): SourceCache {
  const items = new Map(previous.items);
  const windows = new Map(previous.windows);
  const retired = new Set(previous.retired);
  const incoming = new Map<string, FeedItem>();
  const previouslyOwned = new Set([...previous.windows.values()].flat());
  for (const window of pull.windows ?? []) {
    const keys = new Set<string>();
    for (const item of window.items) {
      const key = canonicalKey(item);
      if (!key) continue;
      keys.add(key);
      if (!incoming.has(key)) incoming.set(key, { ...item, id: key });
    }
    windows.set(window.key, [...keys]);
  }
  for (const [key, item] of incoming) items.set(key, item);
  const retained = new Set([...windows.values()].flat());
  const complete = new Set(pull.completeSources ?? []);
  for (const [id, item] of items) {
    // Pre-window snapshots migrate only after all feeds in a source class succeed.
    // Unknown/unmanaged items, including native posts, are never pruned here.
    if (!retained.has(id) && (previouslyOwned.has(id) || complete.has(item.source))) {
      items.delete(id);
      retired.add(id);
    }
  }
  for (const id of items.keys()) retired.delete(id);
  return { items, windows, retired };
}
