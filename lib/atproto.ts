/**
 * ATProto public AppView (no auth, no Neynar).
 * Default: https://public.api.bsky.app
 */

import type { FeedItem, SourcePull } from "./feed-types";
import { normalizeTags } from "./feed-types";
import { canonicalKey } from "./merge";
import { fetchPublic } from "./public-fetch";
import { asString, isRecord } from "./rss3";

export const ATPROTO_APPVIEW_BASE =
  process.env.ATPROTO_APPVIEW_BASE ?? "https://public.api.bsky.app";

const LIMIT = 20;
const BODY_MAX = 320;

export type AtprotoSource =
  | { kind: "author"; actor: string }
  | { kind: "generator"; feed: string };

/**
 * Small documented public set. ethereum.bsky.social author feed + Bluesky's
 * official what's-hot generator. Probed 200 with posts on 2026-09-01.
 */
export const PUBLIC_ATPROTO_SOURCES: AtprotoSource[] = [
  { kind: "author", actor: "ethereum.bsky.social" },
  {
    kind: "generator",
    feed: "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot",
  },
];

export function atprotoPermalink(handle: string, uri: string): string {
  const rkey = uri.split("/").pop() ?? "";
  if (handle && rkey) return `https://bsky.app/profile/${handle}/post/${rkey}`;
  return "";
}

const DID_PLC = /^did:plc:[a-z2-7]{24}$/;

function isRetainedDid(value: string): boolean {
  return DID_PLC.test(value) || value.startsWith("did:web:");
}

function isGetAuthorFeed(url: URL): boolean {
  return url.pathname.endsWith("/app.bsky.feed.getAuthorFeed") || url.pathname.endsWith(".getAuthorFeed");
}

function didForHandle(actor: unknown, handle: string): string | null {
  if (!isRecord(actor)) return null;
  const theirHandle = asString(actor.handle);
  const did = asString(actor.did);
  if (!theirHandle || !did || theirHandle.toLowerCase() !== handle) return null;
  return isRetainedDid(did) ? did : null;
}

/**
 * DID of the actor this author-feed response was fetched for.
 * A DID on the request is kept as-is. A handle is taken from the actor's own posts
 * or from `reason.by` on a repost, and only when every match names the same DID.
 * The post URI is not an actor: a repost's URI is the original author.
 */
export function authorDidForFeed(actor: string, feed: readonly unknown[]): string | null {
  const requested = actor.trim();
  if (isRetainedDid(requested)) return requested;
  if (!requested || requested.startsWith("did:")) return null;
  const handle = requested.toLowerCase();
  let found: string | null = null;
  for (const row of feed) {
    if (!isRecord(row)) continue;
    const reason = isRecord(row.reason) ? row.reason : null;
    const post = isRecord(row.post) ? row.post : null;
    const candidates = [didForHandle(reason?.by, handle), didForHandle(post?.author, handle)];
    for (const did of candidates) {
      if (!did) continue;
      if (!found) found = did;
      else if (found !== did) return null;
    }
  }
  return found;
}

/** Provenance for one AppView response. Author feeds record the actor DID for every row. */
export function atprotoProvenance(requestUrl: string, feed: readonly unknown[]): string {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return `atproto:${requestUrl}`;
  }
  if (!isGetAuthorFeed(url)) return `atproto:${url.toString()}`;
  const did = authorDidForFeed(url.searchParams.get("actor") ?? "", feed);
  if (did) url.searchParams.set("actorDid", did);
  else url.searchParams.delete("actorDid");
  return `atproto:${url.toString()}`;
}

export function normalizeAtprotoPost(raw: unknown, provenance: string): FeedItem | null {
  if (!isRecord(raw) || !isRecord(raw.post)) return null;
  const post = raw.post;
  const uri = asString(post.uri);
  if (!uri) return null;

  const author = isRecord(post.author) ? post.author : {};
  const handle = asString(author.handle) ?? "";
  const record = isRecord(post.record) ? post.record : {};
  const text = asString(record.text) ?? "";
  const createdAt = asString(record.createdAt) ?? asString(post.indexedAt);
  const ts = createdAt ? Math.floor(Date.parse(createdAt) / 1000) : 0;

  return {
    id: uri,
    source: "atproto",
    kind: "social",
    author: handle,
    body: clip(text, BODY_MAX),
    ts: Number.isFinite(ts) ? ts : 0,
    permalink: atprotoPermalink(handle, uri),
    tags: normalizeTags(["atproto", "bsky", "social"]),
    provenance,
  };
}

export async function fetchPublicAtproto(): Promise<SourcePull> {
  const results = await Promise.allSettled(
    PUBLIC_ATPROTO_SOURCES.map((source) => pullSource(source)),
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
      sourcesTried: PUBLIC_ATPROTO_SOURCES.length,
      error:
        "ATProto AppView did not return posts. This feed does not invent rows. " +
        (failures[0] ?? "All AppView requests failed."),
    };
  }

  return {
    items,
    sourcesOk,
    sourcesTried: PUBLIC_ATPROTO_SOURCES.length,
    error: null,
  };
}

async function pullSource(source: AtprotoSource): Promise<FeedItem[]> {
  const url = sourceUrl(source);
  const response = await fetchPublic(url);
  if (!response.ok) {
    throw new Error(`${url} HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.feed)) {
    throw new Error(`${url} unexpected payload`);
  }

  const provenance = atprotoProvenance(url, body.feed);
  const items: FeedItem[] = [];
  for (const row of body.feed) {
    const item = normalizeAtprotoPost(row, provenance);
    if (item) items.push(item);
  }
  return items;
}

function sourceUrl(source: AtprotoSource): string {
  if (source.kind === "author") {
    const url = new URL("/xrpc/app.bsky.feed.getAuthorFeed", ATPROTO_APPVIEW_BASE);
    url.searchParams.set("actor", source.actor);
    url.searchParams.set("limit", String(LIMIT));
    return url.toString();
  }
  const url = new URL("/xrpc/app.bsky.feed.getFeed", ATPROTO_APPVIEW_BASE);
  url.searchParams.set("feed", source.feed);
  url.searchParams.set("limit", String(LIMIT));
  return url.toString();
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
