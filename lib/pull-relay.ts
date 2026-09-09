/**
 * Page ↔ extension / localhost relay contract.
 * Additive to `/api/ingest`. Allowlisted documented sources only —
 * not a general URL proxy, not a second datastore, not a CORS off-switch.
 * Direct browser-to-source still fails in a naked tab. Pull ≠ share ≠ grant.
 * Unknown protocol `v` fails closed. No secrets on Gun / NEXT_PUBLIC.
 */

import { PUBLIC_ACTIVITYPUB_ACTORS, collectOutboxItems } from "./activitypub";
import { PUBLIC_ATPROTO_SOURCES, normalizeAtprotoPost } from "./atproto";
import {
  parseIngestRequest,
  type AllowedSourceClass,
  type ParsedIngestRequest,
} from "./browser-pull";
import {
  PUBLIC_FIDS,
  normalizeHubCast,
  type HubCastMessage,
} from "./farcaster";
import {
  GUN_PROTOCOL_V,
  fromGunNode,
  normalizeTags,
  type FeedItem,
  type SourcePull,
} from "./feed-types";
import { canonicalKey } from "./merge";
import {
  PUBLIC_NOSTR_PUBKEYS,
  kind1Filter,
  normalizeNostrEvent,
  nostrProvenance,
} from "./nostr";
import { normalizeRss3Activities } from "./normalize";
import { PUBLIC_USER_AGENT, PUBLIC_FETCH_MS } from "./public-fetch";
import { PUBLIC_RSS_FEEDS, parseRssAtom } from "./rss-atom";
import {
  PUBLIC_SOURCES,
  asString,
  isRecord,
  isRss3Account,
  type RawActivity,
} from "./rss3";

export const PULL_RELAY_CHANNEL = "s3rch-pull";
export const PULL_RELAY_PROTOCOL_V = 1;
export const PULL_RELAY_LOCAL_HOST = "127.0.0.1";
export const PULL_RELAY_LOCAL_PORT = 17373;
export const PULL_RELAY_LOCAL_ORIGIN = `http://${PULL_RELAY_LOCAL_HOST}:${PULL_RELAY_LOCAL_PORT}`;
export const PULL_RELAY_LOCAL_PATH = "/s3rch-pull";

/** Documented public hosts the relay / extension may fetch. Exact match. */
export const PULL_RELAY_ALLOWED_HOSTS = [
  "hub.pinata.cloud",
  "public.api.bsky.app",
  "blog.ethereum.org",
  "github.com",
  "w3c.social",
  "fosstodon.org",
  "nos.lol",
  "gi.rss3.io",
] as const;

export const PULL_RELAY_FARCASTER_HUB = "https://hub.pinata.cloud";
export const PULL_RELAY_ATPROTO_APPVIEW = "https://public.api.bsky.app";
export const PULL_RELAY_NOSTR_RELAY = "wss://nos.lol";
export const PULL_RELAY_RSS3_GI = "https://gi.rss3.io";

export const PULL_RELAY_EXTENSION_COPY = "Pull via extension.";
export const PULL_RELAY_LOCAL_COPY = "Pull via relay.";

export type PullRelayVia = "extension" | "localhost";

export type PullRelayFetch = {
  url: string;
  status: number;
  body: string;
};

export type PullRelayHello = {
  channel: typeof PULL_RELAY_CHANNEL;
  type: "hello";
  v: typeof PULL_RELAY_PROTOCOL_V;
};

export type PullRelayReady = {
  channel: typeof PULL_RELAY_CHANNEL;
  type: "ready";
  v: typeof PULL_RELAY_PROTOCOL_V;
  via: PullRelayVia;
};

export type PullRelayPull = {
  channel: typeof PULL_RELAY_CHANNEL;
  type: "pull";
  v: typeof PULL_RELAY_PROTOCOL_V;
  id: string;
  body: unknown;
};

export type PullRelayResult = {
  channel: typeof PULL_RELAY_CHANNEL;
  type: "result";
  v: typeof PULL_RELAY_PROTOCOL_V;
  id: string;
  items?: unknown[];
  fetches?: PullRelayFetch[];
  sourcesOk?: number;
  sourcesTried?: number;
  error?: string | null;
};

export type PullRelayDenied = {
  channel: typeof PULL_RELAY_CHANNEL;
  type: "denied";
  v: typeof PULL_RELAY_PROTOCOL_V;
  id?: string;
  error: string;
};

export type ParsedPullRelayMessage =
  | { kind: "hello"; message: PullRelayHello }
  | { kind: "ready"; message: PullRelayReady }
  | { kind: "pull"; message: PullRelayPull }
  | { kind: "result"; message: PullRelayResult }
  | { kind: "denied"; message: PullRelayDenied }
  | { kind: "invalid"; error: string };

export type PullRelayIO = {
  fetchText: (
    url: string,
    init?: { accept?: string },
  ) => Promise<PullRelayFetch>;
  queryNostr?: (
    relay: string,
    filter: { authors: string[]; kinds: number[]; limit: number },
  ) => Promise<unknown[]>;
};

export type PullRelayExecution =
  | { kind: "result"; items: FeedItem[]; sourcesOk: number; sourcesTried: number; error: string | null; fetches: PullRelayFetch[] }
  | { kind: "denied"; error: string };

const ALLOWED_HOST_SET = new Set<string>(PULL_RELAY_ALLOWED_HOSTS);
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const ACTIVITYPUB_ACCEPT =
  'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams", application/json';
const RSS_ACCEPT =
  "application/rss+xml, application/atom+xml, application/xml, text/xml, */*";

export function isPullRelayProtocolV(value: unknown): value is typeof PULL_RELAY_PROTOCOL_V {
  return value === PULL_RELAY_PROTOCOL_V;
}

export function isPullRelayVia(value: unknown): value is PullRelayVia {
  return value === "extension" || value === "localhost";
}

export function isPullRelayAllowedHost(host: string): boolean {
  return ALLOWED_HOST_SET.has(host.trim().toLowerCase().replace(/\.$/, ""));
}

export function isPullRelayAllowedUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return false;
  if (url.username || url.password) return false;
  if (!isPullRelayAllowedHost(url.hostname)) return false;
  if (url.port) {
    const https = url.protocol === "https:" || url.protocol === "wss:";
    if (https && url.port !== "443") return false;
    if (!https && url.port !== "80") return false;
  }
  return true;
}

export function assertPullRelayUrl(raw: string): URL {
  if (!isPullRelayAllowedUrl(raw)) {
    throw new Error("That host is not allowed.");
  }
  return new URL(raw.trim());
}

export function canUsePullRelay(body: unknown): boolean {
  const parsed = parseIngestRequest(body);
  if (parsed.kind === "invalid") return false;
  if (parsed.kind === "allowedSource") return true;
  if (parsed.kind === "rss3Account") return isRss3Account(parsed.rss3Account);
  return isPullRelayAllowedUrl(parsed.rssUrl);
}

export function pullRelayHello(): PullRelayHello {
  return {
    channel: PULL_RELAY_CHANNEL,
    type: "hello",
    v: PULL_RELAY_PROTOCOL_V,
  };
}

export function pullRelayReady(via: PullRelayVia): PullRelayReady {
  return {
    channel: PULL_RELAY_CHANNEL,
    type: "ready",
    v: PULL_RELAY_PROTOCOL_V,
    via,
  };
}

export function pullRelayPull(id: string, body: unknown): PullRelayPull {
  return {
    channel: PULL_RELAY_CHANNEL,
    type: "pull",
    v: PULL_RELAY_PROTOCOL_V,
    id,
    body,
  };
}

export function pullRelayDenied(error: string, id?: string): PullRelayDenied {
  return {
    channel: PULL_RELAY_CHANNEL,
    type: "denied",
    v: PULL_RELAY_PROTOCOL_V,
    ...(id ? { id } : {}),
    error,
  };
}

export function parsePullRelayMessage(raw: unknown): ParsedPullRelayMessage {
  if (!raw || typeof raw !== "object") {
    return { kind: "invalid", error: "Expected JSON." };
  }
  const rec = raw as Record<string, unknown>;
  if (rec.channel !== PULL_RELAY_CHANNEL) {
    return { kind: "invalid", error: "Unknown channel." };
  }
  if (!isPullRelayProtocolV(rec.v)) {
    return { kind: "invalid", error: "Unknown protocol v." };
  }
  const type = rec.type;
  if (type === "hello") {
    return {
      kind: "hello",
      message: {
        channel: PULL_RELAY_CHANNEL,
        type: "hello",
        v: PULL_RELAY_PROTOCOL_V,
      },
    };
  }
  if (type === "ready") {
    if (!isPullRelayVia(rec.via)) {
      return { kind: "invalid", error: "Unknown via." };
    }
    return {
      kind: "ready",
      message: {
        channel: PULL_RELAY_CHANNEL,
        type: "ready",
        v: PULL_RELAY_PROTOCOL_V,
        via: rec.via,
      },
    };
  }
  if (type === "pull") {
    if (typeof rec.id !== "string" || !rec.id.trim()) {
      return { kind: "invalid", error: "Missing pull id." };
    }
    return {
      kind: "pull",
      message: {
        channel: PULL_RELAY_CHANNEL,
        type: "pull",
        v: PULL_RELAY_PROTOCOL_V,
        id: rec.id.trim(),
        body: rec.body,
      },
    };
  }
  if (type === "result") {
    if (typeof rec.id !== "string" || !rec.id.trim()) {
      return { kind: "invalid", error: "Missing result id." };
    }
    return {
      kind: "result",
      message: {
        channel: PULL_RELAY_CHANNEL,
        type: "result",
        v: PULL_RELAY_PROTOCOL_V,
        id: rec.id.trim(),
        items: Array.isArray(rec.items) ? rec.items : undefined,
        fetches: parseFetches(rec.fetches),
        sourcesOk: asCount(rec.sourcesOk),
        sourcesTried: asCount(rec.sourcesTried),
        error: typeof rec.error === "string" || rec.error === null ? rec.error : undefined,
      },
    };
  }
  if (type === "denied") {
    if (typeof rec.error !== "string" || !rec.error.trim()) {
      return { kind: "invalid", error: "Missing deny reason." };
    }
    return {
      kind: "denied",
      message: {
        channel: PULL_RELAY_CHANNEL,
        type: "denied",
        v: PULL_RELAY_PROTOCOL_V,
        id: typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : undefined,
        error: rec.error.trim(),
      },
    };
  }
  return { kind: "invalid", error: "Unknown message type." };
}

function parseFetches(raw: unknown): PullRelayFetch[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PullRelayFetch[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (typeof rec.url !== "string" || typeof rec.body !== "string") continue;
    if (typeof rec.status !== "number" || !Number.isFinite(rec.status)) continue;
    out.push({ url: rec.url, status: rec.status, body: rec.body });
  }
  return out;
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Dest re-authorizes relay rows the same way as `/api/ingest`.
 * Unknown Gun `v` / bad source / empty id write nothing.
 */
export function acceptPullRelayItems(items: unknown[]): FeedItem[] {
  const out: FeedItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const live = fromGunNode(raw as Record<string, unknown>);
    if (!live) continue;
    if ((live.v ?? GUN_PROTOCOL_V) !== GUN_PROTOCOL_V) continue;
    out.push(live);
  }
  return out;
}

export function listPullRelaySeedUrls(
  parsed: Exclude<ParsedIngestRequest, { kind: "invalid" }>,
): string[] {
  if (parsed.kind === "rssUrl") return [parsed.rssUrl];
  if (parsed.kind === "rss3Account") {
    return [
      new URL(
        `/decentralized/${encodeURIComponent(parsed.rss3Account)}`,
        PULL_RELAY_RSS3_GI,
      ).toString(),
    ];
  }
  return seedUrlsForClass(parsed.allowedSource);
}

export function seedUrlsForClass(kind: AllowedSourceClass): string[] {
  switch (kind) {
    case "farcaster":
      return PUBLIC_FIDS.map((fid) => {
        const url = new URL("/v1/castsByFid", PULL_RELAY_FARCASTER_HUB);
        url.searchParams.set("fid", String(fid));
        url.searchParams.set("pageSize", "20");
        url.searchParams.set("reverse", "true");
        return url.toString();
      });
    case "atproto":
      return PUBLIC_ATPROTO_SOURCES.map((source) => {
        if (source.kind === "author") {
          const url = new URL(
            "/xrpc/app.bsky.feed.getAuthorFeed",
            PULL_RELAY_ATPROTO_APPVIEW,
          );
          url.searchParams.set("actor", source.actor);
          url.searchParams.set("limit", "20");
          return url.toString();
        }
        const url = new URL(
          "/xrpc/app.bsky.feed.getFeed",
          PULL_RELAY_ATPROTO_APPVIEW,
        );
        url.searchParams.set("feed", source.feed);
        url.searchParams.set("limit", "20");
        return url.toString();
      });
    case "rss":
      return PUBLIC_RSS_FEEDS.map((feed) => feed.url);
    case "activitypub":
      return [...PUBLIC_ACTIVITYPUB_ACTORS];
    case "nostr":
      return [PULL_RELAY_NOSTR_RELAY];
    case "rss3-gi":
      return PUBLIC_SOURCES.map((source) => {
        const url = new URL(source.path, PULL_RELAY_RSS3_GI);
        url.searchParams.set("limit", "50");
        url.searchParams.set("action_limit", "10");
        if (source.tag) url.searchParams.set("tag", source.tag);
        return url.toString();
      });
  }
}

export function assemblePullRelayFetches(
  parsed: Exclude<ParsedIngestRequest, { kind: "invalid" }>,
  fetches: readonly PullRelayFetch[],
): SourcePull {
  const usable = fetches.filter((row) => isPullRelayAllowedUrl(row.url));
  const sourcesTried = usable.length;
  const sourcesOk = usable.filter((row) => row.status >= 200 && row.status < 300).length;
  let items: FeedItem[] = [];

  if (parsed.kind === "rssUrl") {
    items = assembleRss(usable, true);
  } else if (parsed.kind === "rss3Account") {
    items = assembleGi(usable);
  } else {
    switch (parsed.allowedSource) {
      case "farcaster":
        items = assembleFarcaster(usable);
        break;
      case "atproto":
        items = assembleAtproto(usable);
        break;
      case "rss":
        items = assembleRss(usable, false);
        break;
      case "activitypub":
        items = assembleActivityPub(usable);
        break;
      case "nostr":
        items = assembleNostr(usable);
        break;
      case "rss3-gi":
        items = assembleGi(usable);
        break;
    }
  }

  items = dedupeItems(acceptPullRelayItems(items));
  return {
    items,
    sourcesOk,
    sourcesTried,
    error:
      sourcesOk === 0
        ? "Source pull failed."
        : items.length === 0
          ? "Source contained no entries."
          : null,
  };
}

export function materializePullRelayResult(
  body: unknown,
  message: PullRelayResult,
): SourcePull {
  const parsed = parseIngestRequest(body);
  if (parsed.kind === "invalid") {
    return {
      items: [],
      sourcesOk: 0,
      sourcesTried: 0,
      error: parsed.error,
    };
  }
  if (message.fetches?.length) {
    return assemblePullRelayFetches(parsed, message.fetches);
  }
  const items = acceptPullRelayItems(message.items ?? []);
  const sourcesOk = message.sourcesOk ?? (items.length ? 1 : 0);
  const sourcesTried = message.sourcesTried ?? 1;
  return {
    items,
    sourcesOk,
    sourcesTried,
    error:
      items.length > 0
        ? null
        : message.error ?? (sourcesOk === 0 ? "Source pull failed." : "Source contained no entries."),
  };
}

export async function executePullRelay(
  body: unknown,
  io: PullRelayIO,
): Promise<PullRelayExecution> {
  const parsed = parseIngestRequest(body);
  if (parsed.kind === "invalid") {
    return { kind: "denied", error: parsed.error };
  }
  if (parsed.kind === "rssUrl" && !isPullRelayAllowedUrl(parsed.rssUrl)) {
    return { kind: "denied", error: "That host is not allowed." };
  }
  if (parsed.kind === "rss3Account" && !isRss3Account(parsed.rss3Account)) {
    return { kind: "denied", error: "That does not look like an RSS3 account." };
  }

  const fetches: PullRelayFetch[] = [];

  if (parsed.kind === "allowedSource" && parsed.allowedSource === "nostr") {
    if (!io.queryNostr) {
      return { kind: "denied", error: "Nostr relay query is not available." };
    }
    if (!isPullRelayAllowedUrl(PULL_RELAY_NOSTR_RELAY)) {
      return { kind: "denied", error: "That host is not allowed." };
    }
    const events: unknown[] = [];
    let ok = 0;
    for (const pubkey of PUBLIC_NOSTR_PUBKEYS) {
      try {
        const got = await io.queryNostr(PULL_RELAY_NOSTR_RELAY, kind1Filter(pubkey));
        events.push(...got);
        ok += 1;
      } catch {
        /* empty source writes nothing */
      }
    }
    fetches.push({
      url: PULL_RELAY_NOSTR_RELAY,
      status: ok > 0 ? 200 : 502,
      body: JSON.stringify(events),
    });
  } else if (parsed.kind === "allowedSource" && parsed.allowedSource === "activitypub") {
    for (const actor of PUBLIC_ACTIVITYPUB_ACTORS) {
      const actorFetch = await guardedFetch(io, actor, ACTIVITYPUB_ACCEPT);
      fetches.push(actorFetch);
      if (actorFetch.status < 200 || actorFetch.status >= 300) continue;
      for (const next of followActivityPub(actorFetch)) {
        const outboxFetch = await guardedFetch(io, next, ACTIVITYPUB_ACCEPT);
        fetches.push(outboxFetch);
        for (const page of followActivityPubFirstPage(outboxFetch)) {
          fetches.push(await guardedFetch(io, page, ACTIVITYPUB_ACCEPT));
        }
      }
    }
  } else {
    const accept =
      parsed.kind === "rssUrl" ||
      (parsed.kind === "allowedSource" && parsed.allowedSource === "rss")
        ? RSS_ACCEPT
        : "application/json";
    for (const url of listPullRelaySeedUrls(parsed)) {
      if (!isPullRelayAllowedUrl(url)) {
        return { kind: "denied", error: "That host is not allowed." };
      }
      fetches.push(await guardedFetch(io, url, accept));
    }
  }

  const assembled = assemblePullRelayFetches(parsed, fetches);
  return { kind: "result", ...assembled, fetches };
}

export function followActivityPub(actorFetch: PullRelayFetch): string[] {
  if (actorFetch.status < 200 || actorFetch.status >= 300) return [];
  let json: unknown;
  try {
    json = JSON.parse(actorFetch.body);
  } catch {
    return [];
  }
  if (!isRecord(json)) return [];
  const out: string[] = [];
  const outbox = hrefOf(json.outbox, actorFetch.url);
  if (outbox && isPullRelayAllowedUrl(outbox)) out.push(outbox);
  return out;
}

/** First OrderedCollection page only, and only when the outbox itself is empty. */
export function followActivityPubFirstPage(outboxFetch: PullRelayFetch): string[] {
  if (outboxFetch.status < 200 || outboxFetch.status >= 300) return [];
  let json: unknown;
  try {
    json = JSON.parse(outboxFetch.body);
  } catch {
    return [];
  }
  if (!isRecord(json)) return [];
  const embedded = Array.isArray(json.orderedItems)
    ? json.orderedItems
    : Array.isArray(json.items)
      ? json.items
      : [];
  if (embedded.length > 0) return [];
  const first = hrefOf(json.first, outboxFetch.url);
  if (first && isPullRelayAllowedUrl(first)) return [first];
  return [];
}

export async function nodePullRelayFetch(
  url: string,
  init?: { accept?: string },
): Promise<PullRelayFetch> {
  const response = await fetch(url, {
    headers: {
      accept: init?.accept ?? "application/json",
      "user-agent": PUBLIC_USER_AGENT,
    },
    signal: AbortSignal.timeout(PUBLIC_FETCH_MS),
    redirect: "follow",
    cache: "no-store",
  });
  return {
    url: response.url || url,
    status: response.status,
    body: await response.text(),
  };
}

export function isPullRelayPageOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1";
}

async function guardedFetch(
  io: PullRelayIO,
  url: string,
  accept: string,
): Promise<PullRelayFetch> {
  if (!isPullRelayAllowedUrl(url)) {
    return { url, status: 0, body: "" };
  }
  try {
    const got = await io.fetchText(url, { accept });
    if (!isPullRelayAllowedUrl(got.url)) {
      return { url: got.url, status: 0, body: "" };
    }
    return got;
  } catch {
    return { url, status: 502, body: "" };
  }
}

function hrefOf(value: unknown, base: string): string | null {
  const direct = asString(value);
  if (direct) {
    try {
      return new URL(direct, base).toString();
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = hrefOf(entry, base);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  return hrefOf(value.href ?? value.id ?? value.url, base);
}

function assembleFarcaster(fetches: readonly PullRelayFetch[]): FeedItem[] {
  const items: FeedItem[] = [];
  for (const row of fetches) {
    if (row.status < 200 || row.status >= 300) continue;
    let json: unknown;
    try {
      json = JSON.parse(row.body);
    } catch {
      continue;
    }
    if (!isRecord(json) || !Array.isArray(json.messages)) continue;
    const provenance = `farcaster:hub:${row.url}`;
    for (const raw of json.messages) {
      const item = normalizeHubCast(raw as HubCastMessage, null, provenance);
      if (item) items.push(item);
    }
  }
  return items;
}

function assembleAtproto(fetches: readonly PullRelayFetch[]): FeedItem[] {
  const items: FeedItem[] = [];
  for (const row of fetches) {
    if (row.status < 200 || row.status >= 300) continue;
    let json: unknown;
    try {
      json = JSON.parse(row.body);
    } catch {
      continue;
    }
    if (!isRecord(json) || !Array.isArray(json.feed)) continue;
    const provenance = `atproto:${row.url}`;
    for (const raw of json.feed) {
      const item = normalizeAtprotoPost(raw, provenance);
      if (item) items.push(item);
    }
  }
  return items;
}

function assembleRss(
  fetches: readonly PullRelayFetch[],
  overlayUser: boolean,
): FeedItem[] {
  const items: FeedItem[] = [];
  for (const row of fetches) {
    if (row.status < 200 || row.status >= 300 || !row.body) continue;
    const parsed = parseRssAtom(row.body, row.url);
    const extra =
      PUBLIC_RSS_FEEDS.find((feed) => feed.url === row.url)?.extraTags ?? [];
    for (const item of parsed.items) {
      items.push({
        ...item,
        tags: overlayUser
          ? item.tags
          : normalizeTags([
              ...item.tags.filter((tag) => tag !== "user"),
              ...extra,
            ]),
      });
    }
  }
  return items;
}

function assembleActivityPub(fetches: readonly PullRelayFetch[]): FeedItem[] {
  const items: FeedItem[] = [];
  for (const row of fetches) {
    if (row.status < 200 || row.status >= 300) continue;
    let json: unknown;
    try {
      json = JSON.parse(row.body);
    } catch {
      continue;
    }
    items.push(...collectOutboxItems(json, `activitypub:${row.url}`));
  }
  return items;
}

function assembleNostr(fetches: readonly PullRelayFetch[]): FeedItem[] {
  const items: FeedItem[] = [];
  for (const row of fetches) {
    if (row.status < 200 || row.status >= 300) continue;
    let json: unknown;
    try {
      json = JSON.parse(row.body);
    } catch {
      continue;
    }
    const events = Array.isArray(json)
      ? json
      : isRecord(json) && Array.isArray(json.events)
        ? json.events
        : [];
    for (const event of events) {
      const pubkey = isRecord(event) ? asString(event.pubkey) ?? "" : "";
      const item = normalizeNostrEvent(
        event,
        nostrProvenance(row.url, pubkey),
      );
      if (item) items.push(item);
    }
  }
  return items;
}

function assembleGi(fetches: readonly PullRelayFetch[]): FeedItem[] {
  const items: FeedItem[] = [];
  for (const row of fetches) {
    if (row.status < 200 || row.status >= 300) continue;
    let json: unknown;
    try {
      json = JSON.parse(row.body);
    } catch {
      continue;
    }
    const data =
      isRecord(json) && Array.isArray(json.data) ? json.data : null;
    if (!data) continue;
    items.push(
      ...normalizeRss3Activities(
        data.filter(isRecord) as RawActivity[],
        `rss3:gi:${row.url}`,
      ),
    );
  }
  return items;
}

function dedupeItems(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const item of items) {
    const key = canonicalKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
