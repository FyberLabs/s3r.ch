import type { FeedItem } from "./feed-types";
import { normalizeTags } from "./feed-types";
import { canonicalKey } from "./merge";
import { asString, isRecord, type RawAction, type RawActivity } from "./rss3";

const BODY_MAX = 320;

export function normalizeRss3Activities(
  activities: RawActivity[],
  provenance: string,
): FeedItem[] {
  const items: FeedItem[] = [];
  const seen = new Set<string>();

  for (const activity of activities) {
    const item = normalizeRss3Activity(activity, provenance);
    if (!item) continue;
    const key = canonicalKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }

  return items;
}

export function normalizeRss3Activity(
  activity: RawActivity,
  provenance: string,
): FeedItem | null {
  const action = firstAction(activity);
  const id =
    asString(activity.id) ??
    asString(action ? firstHttpUrl(action.related_urls) : null);
  if (!id) return null;

  const tag =
    asString(action?.tag) ?? asString(activity.tag) ?? "activity";
  const type = asString(action?.type) ?? asString(activity.type);
  const network = asString(activity.network);
  const platform =
    asString(action?.platform) ?? asString(activity.platform);
  const meta = isRecord(action?.metadata) ? action.metadata : {};

  const author =
    asString(meta.handle) ??
    asString(activity.owner) ??
    asString(activity.from) ??
    asString(action?.from) ??
    "";

  const body = buildBody(tag, type, meta);
  const permalink =
    firstHttpUrl(action?.related_urls) ??
    asString(meta.target_url) ??
    asString(meta.content_uri) ??
    "";

  const tags = normalizeTags(
    [tag, type, network, platform].filter((value): value is string => Boolean(value)),
  );

  return {
    id,
    source: "rss3",
    kind: tag,
    author,
    body,
    ts: typeof activity.timestamp === "number" && Number.isFinite(activity.timestamp)
      ? activity.timestamp
      : 0,
    permalink,
    tags,
    provenance,
  };
}

function firstAction(activity: RawActivity): RawAction | undefined {
  return Array.isArray(activity.actions) && activity.actions.length > 0
    ? activity.actions[0]
    : undefined;
}

function buildBody(
  tag: string,
  type: string | null,
  meta: Record<string, unknown>,
): string {
  const extra =
    asString(meta.title) ??
    asString(meta.body) ??
    asString(meta.summary) ??
    asString(meta.symbol) ??
    asString(meta.name);
  const base = type ? `${tag} ${type}` : tag;
  const text = extra ? `${base} · ${extra}` : base;
  return clip(text, BODY_MAX);
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

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
