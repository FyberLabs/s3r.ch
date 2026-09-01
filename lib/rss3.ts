/**
 * Documented RSS3 Global Indexer paths only.
 * Default host https://gi.rss3.io currently has no public DNS A/AAAA/CNAME
 * (confirmed 2026-08-31 / 2026-09-01 via Cloudflare and Google DoH).
 * Public seed treats GI as optional: a DNS or HTTP failure is a failed
 * source, not a reason to drop Farcaster / ATProto / RSS pulls.
 * https://docs.rss3.io/guide/developer/api
 *
 * Public lists: GET /decentralized/network/{network}
 *               GET /decentralized/platform/{platform}
 * Account overlay: GET /decentralized/{account}
 */

import { fetchPublic, PUBLIC_USER_AGENT } from "./public-fetch";

export const GI_BASE = process.env.RSS3_GI_BASE ?? "https://gi.rss3.io";
export const GI_USER_AGENT = PUBLIC_USER_AGENT;
const LIMIT = 50;

export type Rss3Source = {
  path: string;
  tag: string;
};

/** Optional public seed lists. Used only when GI_BASE responds. */
export const PUBLIC_SOURCES: Rss3Source[] = [
  { path: "/decentralized/network/ethereum", tag: "social" },
  { path: "/decentralized/network/ethereum", tag: "transaction" },
  { path: "/decentralized/network/base", tag: "transaction" },
  { path: "/decentralized/network/farcaster", tag: "social" },
  { path: "/decentralized/platform/Farcaster", tag: "social" },
  { path: "/decentralized/platform/Lens", tag: "social" },
];

export type RawAction = {
  from?: string;
  to?: string;
  tag?: string;
  type?: string;
  platform?: string;
  related_urls?: unknown;
  metadata?: unknown;
};

export type RawActivity = {
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

export type GiFetchResult = {
  activities: RawActivity[];
  sourcesOk: number;
  sourcesTried: number;
  error: string | null;
};

export async function fetchPublicActivities(): Promise<GiFetchResult> {
  return fetchSources(PUBLIC_SOURCES);
}

export async function fetchAccountActivities(account: string): Promise<GiFetchResult> {
  return fetchSources([{ path: `/decentralized/${encodeURIComponent(account)}`, tag: "" }]);
}

async function fetchSources(sources: Rss3Source[]): Promise<GiFetchResult> {
  const results = await Promise.allSettled(
    sources.map((source) => fetchActivities(source.path, source.tag)),
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
      activities: [],
      sourcesOk: 0,
      sourcesTried: sources.length,
      error:
        "RSS3 Global Indexer did not return activities. This feed does not invent rows. " +
        (failures[0] ?? "All GI requests failed."),
    };
  }

  return {
    activities,
    sourcesOk,
    sourcesTried: sources.length,
    error: null,
  };
}

async function fetchActivities(path: string, tag: string): Promise<RawActivity[]> {
  const url = new URL(path, GI_BASE);
  url.searchParams.set("limit", String(LIMIT));
  url.searchParams.set("action_limit", "10");
  if (tag) url.searchParams.set("tag", tag);

  const response = await fetchPublic(url);

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isRss3Account(value: string): boolean {
  const account = value.trim();
  if (!account || account.length > 128) return false;
  if (account.includes("/") || account.includes(":") || /\s/.test(account)) {
    return false;
  }
  if (/^0x[a-fA-F0-9]{40}$/.test(account)) return true;
  if (/^[a-zA-Z0-9-]+\.eth$/.test(account)) return true;
  return /^[a-zA-Z0-9._-]+$/.test(account);
}
