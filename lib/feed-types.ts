/**
 * Shared feed item shape. Public cache, snapshot, personal overlay, and
 * (later) the mesh all use this. Tabs are typed for later — no tab UI here.
 */

export type FeedSource = "rss3" | "rss" | "atom" | "farcaster" | "atproto";

export const FEED_SOURCES: readonly FeedSource[] = [
  "rss3",
  "rss",
  "atom",
  "farcaster",
  "atproto",
];

export function isFeedSource(value: unknown): value is FeedSource {
  return typeof value === "string" && (FEED_SOURCES as readonly string[]).includes(value);
}

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

/** One public seed pull (hub FID, AppView feed, RSS URL, or GI list). */
export type SourcePull = {
  items: FeedItem[];
  sourcesOk: number;
  sourcesTried: number;
  error: string | null;
};

/** Later: Public / Mine / Network. Do not render tabs from this type yet. */
export type FeedTab = "public" | "mine" | "network";

/**
 * Later user node. gun.get('s3rch').get('users').get(wallet)
 * On the Gun wire, indicators are a comma-separated string.
 */
export type GunUserNode = {
  id: string;
  indicators: string[];
  provenance: string;
  ts: number;
};

/** Issuers prove a claim to the holder. They are not grants. */
export type IdentityClaimKind = "wallet" | "rss3" | "ens" | "kyc_attestation" | "email" | "phone";

/**
 * Jointly stated see grant. hopcap 1. Privilege-down is immediate.
 * `from` inclusive, `until` exclusive.
 */
export type IdentitySeeGrant = {
  claimId: string;
  accessor: string;
  from: number;
  until: number;
};

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
  if (!isFeedSource(source)) {
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
