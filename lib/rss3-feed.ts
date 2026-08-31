/**
 * Public RSS3 Data Sublayer activity board.
 * Uses documented GI endpoints only — no search-query API.
 * https://gi.rss3.io  https://docs.rss3.io/guide/developer/api
 */

const GI_BASE = process.env.RSS3_GI_BASE ?? "https://gi.rss3.io";
const FETCH_MS = 8_000;
const CACHE_OK_MS = 60_000;
const CACHE_ERR_MS = 15_000;
const LIMIT = 50;
const RAIL_SIZE = 12;
const USER_AGENT = "s3r.ch-research-feed/0.1 (Fyber Labs)";

/** Documented network / platform activity lists. Not a search box. */
const SOURCES: { path: string; tag: string }[] = [
  { path: "/decentralized/network/ethereum", tag: "social" },
  { path: "/decentralized/network/ethereum", tag: "transaction" },
  { path: "/decentralized/network/base", tag: "transaction" },
  { path: "/decentralized/network/farcaster", tag: "social" },
  { path: "/decentralized/platform/Farcaster", tag: "social" },
  { path: "/decentralized/platform/Lens", tag: "social" },
];

export type FeedRow = {
  key: string;
  kind: "social" | "contract";
  label: string;
  network: string | null;
  platform: string | null;
  timestamp: number | null;
  action: string;
  count: number;
  volumeHint: string | null;
  href: string | null;
  novelty: "first-seen" | "rare" | "repeated";
};

export type FeedResult = {
  popular: FeedRow[];
  novel: FeedRow[];
  fetchedAt: string;
  sourcesOk: number;
  sourcesTried: number;
  error: string | null;
};

type RawAction = {
  from?: string;
  to?: string;
  tag?: string;
  type?: string;
  platform?: string;
  related_urls?: unknown;
  metadata?: unknown;
};

type RawActivity = {
  id?: string;
  from?: string;
  to?: string;
  owner?: string;
  network?: string;
  platform?: string;
  tag?: string;
  type?: string;
  timestamp?: number;
  actions?: RawAction[];
};

type Target = {
  key: string;
  kind: "social" | "contract";
  label: string;
};

type Bucket = {
  target: Target;
  count: number;
  volume: bigint;
  timestamp: number;
  network: string | null;
  platform: string | null;
  action: string;
  href: string | null;
};

type CacheBox = { expires: number; value: FeedResult };
let cache: CacheBox | null = null;
let inflight: Promise<FeedResult> | null = null;

export async function getFeed(): Promise<FeedResult> {
  if (cache && cache.expires > Date.now()) {
    return cache.value;
  }
  if (inflight) {
    return inflight;
  }
  inflight = loadFeed()
    .then((value) => {
      const ttl =
        value.error && value.popular.length === 0 && value.novel.length === 0
          ? CACHE_ERR_MS
          : CACHE_OK_MS;
      cache = { expires: Date.now() + ttl, value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function loadFeed(): Promise<FeedResult> {
  const fetchedAt = new Date().toISOString();
  const results = await Promise.allSettled(
    SOURCES.map((source) => fetchActivities(source.path, source.tag)),
  );

  const activities: RawActivity[] = [];
  let sourcesOk = 0;
  const failures: string[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      sourcesOk += 1;
      activities.push(...result.value);
    } else {
      failures.push(
        result.reason instanceof Error ? result.reason.message : String(result.reason),
      );
    }
  }

  if (sourcesOk === 0) {
    return {
      popular: [],
      novel: [],
      fetchedAt,
      sourcesOk: 0,
      sourcesTried: SOURCES.length,
      error:
        "RSS3 Global Indexer did not return activities. This board does not invent rows. " +
        (failures[0] ?? "All GI requests failed."),
    };
  }

  const { popular, novel } = aggregateActivities(activities);
  return {
    popular,
    novel,
    fetchedAt,
    sourcesOk,
    sourcesTried: SOURCES.length,
    error: null,
  };
}

async function fetchActivities(path: string, tag: string): Promise<RawActivity[]> {
  const url = new URL(path, GI_BASE);
  url.searchParams.set("limit", String(LIMIT));
  url.searchParams.set("action_limit", "10");
  url.searchParams.set("tag", tag);

  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_MS),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`${path} HTTP ${response.status}`);
  }

  const body: unknown = await response.json();
  const data =
    body &&
    typeof body === "object" &&
    "data" in body &&
    Array.isArray((body as { data: unknown }).data)
      ? (body as { data: unknown[] }).data
      : null;

  if (!data) {
    throw new Error(`${path} unexpected payload`);
  }

  return data.filter(isRecord) as RawActivity[];
}

export function aggregateActivities(activities: RawActivity[]): {
  popular: FeedRow[];
  novel: FeedRow[];
} {
  const seenIds = new Set<string>();
  const buckets = new Map<string, Bucket>();

  for (const activity of activities) {
    const id = asString(activity.id);
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }

    const actions =
      Array.isArray(activity.actions) && activity.actions.length > 0
        ? activity.actions
        : [undefined];

    for (const action of actions) {
      const target = extractTarget(activity, action);
      if (!target) continue;

      const existing = buckets.get(target.key);
      const timestamp = asUnix(activity.timestamp);
      const href = firstHttpUrl(action?.related_urls);
      const volume = parseVolume(action?.metadata);
      const actionLabel = humanAction(activity, action);

      if (existing) {
        existing.count += 1;
        existing.volume += volume;
        if (timestamp > existing.timestamp) {
          existing.timestamp = timestamp;
          existing.action = actionLabel;
          existing.network = asString(activity.network) ?? existing.network;
          existing.platform =
            asString(action?.platform) ??
            asString(activity.platform) ??
            existing.platform;
          if (href) existing.href = href;
        }
      } else {
        buckets.set(target.key, {
          target,
          count: 1,
          volume,
          timestamp,
          network: asString(activity.network),
          platform: asString(action?.platform) ?? asString(activity.platform),
          action: actionLabel,
          href,
        });
      }
    }
  }

  const rows = Array.from(buckets.values()).map(toRow);
  const popular = rows
    .filter((row) => row.count >= 2)
    .sort((a, b) => b.count - a.count || (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .slice(0, RAIL_SIZE);
  const novel = rows
    .filter((row) => row.count === 1)
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .slice(0, RAIL_SIZE);

  return { popular, novel };
}

function toRow(bucket: Bucket): FeedRow {
  return {
    key: bucket.target.key,
    kind: bucket.target.kind,
    label: bucket.target.label,
    network: bucket.network,
    platform: bucket.platform,
    timestamp: bucket.timestamp || null,
    action: bucket.action,
    count: bucket.count,
    volumeHint: bucket.volume > BigInt(0) ? bucket.volume.toString() : null,
    href: bucket.href,
    novelty: bucket.count === 1 ? "first-seen" : bucket.count <= 3 ? "rare" : "repeated",
  };
}

function extractTarget(
  activity: RawActivity,
  action: RawAction | undefined,
): Target | null {
  const tag = asString(action?.tag) ?? asString(activity.tag) ?? "";
  const meta = isRecord(action?.metadata) ? action.metadata : {};

  if (tag === "social") {
    const handle = asString(meta.handle);
    const targetUrl =
      asString(meta.target_url) ?? asString(meta.content_uri) ?? asString(meta.author_url);
    const publication = asString(meta.publication_id);
    const raw = handle ?? targetUrl ?? publication ?? asString(action?.to) ?? asString(activity.to);
    if (!raw) return null;
    return {
      kind: "social",
      key: `social:${raw.toLowerCase()}`,
      label: handle ? `@${handle}` : shorten(raw),
    };
  }

  const address =
    asString(meta.address) ?? asString(action?.to) ?? asString(activity.to);
  if (!address) return null;
  const network = asString(activity.network) ?? "unknown";
  const name = asString(meta.symbol) ?? asString(meta.name);
  return {
    kind: "contract",
    key: `contract:${network}:${address.toLowerCase()}`,
    label: name ?? shorten(address),
  };
}

function humanAction(activity: RawActivity, action: RawAction | undefined): string {
  const tag = asString(action?.tag) ?? asString(activity.tag) ?? "activity";
  const type = asString(action?.type) ?? asString(activity.type) ?? "";
  const meta = isRecord(action?.metadata) ? action.metadata : {};
  const extra =
    asString(meta.title) ??
    asString(meta.symbol) ??
    clip(asString(meta.body) ?? asString(meta.summary), 80);
  const base = type ? `${tag} ${type}` : tag;
  return extra ? `${base} · ${extra}` : base;
}

function parseVolume(metadata: unknown): bigint {
  if (!isRecord(metadata)) return BigInt(0);
  const value = metadata.value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return BigInt(0);
    }
  }
  return BigInt(0);
}

function firstHttpUrl(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item === "string" && /^https?:\/\//i.test(item)) {
      return item;
    }
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asUnix(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shorten(value: string): string {
  if (value.startsWith("0x") && value.length > 12) {
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
  }
  if (value.length > 36) {
    return `${value.slice(0, 28)}…`;
  }
  return value;
}

function clip(value: string | null, max: number): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
