/**
 * ActivityPub inbound (no outbound). Pull a documented public actor,
 * then the outbox OrderedCollection first page (subset). Embedded
 * Create/Note objects only — string IDs are skipped, not fetched.
 *
 * Direct browser-to-source still fails CORS. Seeder and `/api/ingest`
 * fetch server-side. Empty / failed actors write nothing.
 */

import type { FeedItem, SourcePull } from "./feed-types";
import { normalizeTags } from "./feed-types";
import { canonicalKey } from "./merge";
import { fetchPublic } from "./public-fetch";
import { asString, isRecord } from "./rss3";
import { assertPublicHttpUrl } from "./url-guard";

export const ACTIVITYPUB_ACCEPT =
  'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams", application/json';

const LIMIT = 20;
const BODY_MAX = 320;

/**
 * Small documented public set. Instances that return actor + outbox JSON
 * without HTTP signatures (authorized fetch). mastodon.social is 401
 * "Request not signed" — we do not sign GETs; Azure is not an AP server.
 * Outbox first page is the subset we admit. Not a search API.
 */
export const PUBLIC_ACTIVITYPUB_ACTORS = [
  "https://w3c.social/users/w3c",
  "https://fosstodon.org/users/Fosstodon",
] as const;

export function activityPubPermalink(raw: unknown, fallbackId: string): string {
  const fromUrl = firstHref(raw);
  if (fromUrl) return fromUrl;
  return fallbackId.startsWith("http://") || fallbackId.startsWith("https://")
    ? fallbackId
    : "";
}

/**
 * Map one outbox row. Create → object; bare Note; anything else / string id → null.
 */
export function normalizeActivityPubItem(
  raw: unknown,
  provenance: string,
  actorName = "",
): FeedItem | null {
  if (typeof raw === "string") return null;
  if (!isRecord(raw)) return null;

  const type = asString(raw.type);
  const object =
    type === "Create" && raw.object !== undefined ? raw.object : raw;
  if (typeof object === "string" || !isRecord(object)) return null;

  const objectType = asString(object.type);
  if (objectType && objectType !== "Note" && objectType !== "Article") {
    return null;
  }

  const id = asString(object.id) ?? asString(raw.id);
  if (!id) return null;

  const author =
    actorName ||
    nameFromAttributed(object.attributedTo) ||
    nameFromAttributed(raw.actor) ||
    hostnameOf(id);

  const published =
    asString(object.published) ?? asString(raw.published) ?? "";
  const ts = published ? Math.floor(Date.parse(published) / 1000) : 0;

  return {
    id,
    source: "activitypub",
    kind: "social",
    author,
    body: clip(stripTags(asString(object.content) ?? asString(object.summary) ?? ""), BODY_MAX),
    ts: Number.isFinite(ts) ? ts : 0,
    permalink: activityPubPermalink(object.url, id),
    tags: normalizeTags(["activitypub", "social"]),
    provenance,
  };
}

export function collectOutboxItems(
  collection: unknown,
  provenance: string,
  actorName = "",
): FeedItem[] {
  const rows = collectionItems(collection);
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, LIMIT)) {
    const item = normalizeActivityPubItem(row, provenance, actorName);
    if (!item) continue;
    const key = canonicalKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

export async function fetchPublicActivityPub(): Promise<SourcePull> {
  const results = await Promise.allSettled(
    PUBLIC_ACTIVITYPUB_ACTORS.map((actor) => pullActor(actor)),
  );

  const items: FeedItem[] = [];
  const seen = new Set<string>();
  let sourcesOk = 0;
  const failures: string[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      sourcesOk += 1;
      for (const item of result.value) {
        const key = canonicalKey(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push(item);
      }
    } else {
      failures.push(
        result.reason instanceof Error ? result.reason.message : String(result.reason),
      );
    }
  }

  if (sourcesOk === 0) {
    return {
      items: [],
      sourcesOk: 0,
      sourcesTried: PUBLIC_ACTIVITYPUB_ACTORS.length,
      error:
        "ActivityPub outbox did not return notes. This feed does not invent rows. " +
        (failures[0] ?? "All actor requests failed."),
    };
  }

  return {
    items,
    sourcesOk,
    sourcesTried: PUBLIC_ACTIVITYPUB_ACTORS.length,
    error: null,
  };
}

async function pullActor(actorUrl: string): Promise<FeedItem[]> {
  const actor = await fetchActivityJson(actorUrl);
  const actorName =
    asString(actor.preferredUsername) ?? asString(actor.name) ?? "";
  const outboxUrl = resolvePublicActivityUrl(actor.outbox, actorUrl);
  if (!outboxUrl) {
    throw new Error(`${actorUrl} has no outbox`);
  }

  const outbox = await fetchActivityJson(outboxUrl);
  const provenance = `activitypub:${outboxUrl}`;
  if (collectionItems(outbox).length > 0) {
    return collectOutboxItems(outbox, provenance, actorName);
  }

  const firstUrl = resolvePublicActivityUrl(outbox.first, outboxUrl);
  if (!firstUrl) {
    return [];
  }
  const page = await fetchActivityJson(firstUrl);
  return collectOutboxItems(page, provenance, actorName);
}

async function fetchActivityJson(rawUrl: string): Promise<Record<string, unknown>> {
  const url = assertPublicHttpUrl(rawUrl);
  const response = await fetchPublic(url, { accept: ACTIVITYPUB_ACCEPT });
  if (!response.ok) {
    throw new Error(`${url} HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body)) {
    throw new Error(`${url} unexpected payload`);
  }
  return body;
}

function collectionItems(collection: unknown): unknown[] {
  if (!isRecord(collection)) return [];
  if (Array.isArray(collection.orderedItems)) return collection.orderedItems;
  if (Array.isArray(collection.items)) return collection.items;
  return [];
}

/** Followed outbox / first URLs must be public http(s). Local/metadata hosts fail closed. */
export function resolvePublicActivityUrl(value: unknown, base: string): string | null {
  const href = firstHref(value);
  if (!href) return null;
  try {
    return assertPublicHttpUrl(new URL(href, base).toString()).toString();
  } catch {
    return null;
  }
}

function firstHref(value: unknown): string | null {
  const direct = asString(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstHref(entry);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  return asString(value.href) ?? asString(value.id) ?? asString(value.url);
}

function nameFromAttributed(value: unknown): string {
  const href = typeof value === "string" ? value : "";
  if (isRecord(value)) {
    return (
      asString(value.preferredUsername) ??
      asString(value.name) ??
      hostnameOf(asString(value.id) ?? "")
    );
  }
  if (!href) return "";
  try {
    const path = new URL(href).pathname.replace(/\/+$/, "");
    const leaf = path.split("/").pop() ?? "";
    return leaf.startsWith("@") ? leaf.slice(1) : leaf;
  } catch {
    return "";
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
