/**
 * Shared feed item shape. Gun, the snapshot API, and user overlay
 * all use this. Tabs are typed for later — no tab UI in this slice.
 */

export type FeedSource = "rss3" | "rss" | "atom";

export type FeedItem = {
  id: string;
  source: FeedSource;
  kind: string;
  author: string;
  body: string;
  ts: number;
  permalink: string;
  tags: string[];
  provenance: string;
};

/** Later: Public / Mine / Network. Do not render tabs from this type yet. */
export type FeedTab = "public" | "mine" | "network";

export type SeedReport = {
  items: FeedItem[];
  seededAt: string | null;
  sourcesOk: number;
  sourcesTried: number;
  written: number;
  error: string | null;
};

export type FeedSnapshot = {
  items: FeedItem[];
  seededAt: string | null;
  sourcesOk: number;
  sourcesTried: number;
  error: string | null;
};

/** Gun cannot store arrays; tags travel as a comma-separated string. */
export type GunFeedNode = {
  id: string;
  source: string;
  kind: string;
  author: string;
  body: string;
  ts: number;
  permalink: string;
  tags: string;
  provenance: string;
};

export function toGunNode(item: FeedItem): GunFeedNode {
  return {
    id: item.id,
    source: item.source,
    kind: item.kind,
    author: item.author,
    body: item.body,
    ts: item.ts,
    permalink: item.permalink,
    tags: item.tags.join(","),
    provenance: item.provenance,
  };
}

export function fromGunNode(node: Partial<GunFeedNode> | null | undefined): FeedItem | null {
  if (!node || typeof node.id !== "string" || !node.id.trim()) {
    return null;
  }
  const source = node.source;
  if (source !== "rss3" && source !== "rss" && source !== "atom") {
    return null;
  }
  return {
    id: node.id.trim(),
    source,
    kind: asText(node.kind) || "activity",
    author: asText(node.author),
    body: asText(node.body),
    ts: typeof node.ts === "number" && Number.isFinite(node.ts) ? node.ts : 0,
    permalink: asText(node.permalink),
    tags: splitTags(node.tags),
    provenance: asText(node.provenance),
  };
}

export function splitTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeTags(value.filter((tag): tag is string => typeof tag === "string"));
  }
  if (typeof value === "string") {
    return normalizeTags(value.split(","));
  }
  return [];
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
