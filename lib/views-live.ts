/**
 * Live data for the View route: subscriptions that follow the open View, the first time
 * each row was seen, per-source row bounds, access re-checks, and the Browse catalog.
 *
 * `DEPLOYMENT_SELF_NETWORK` is this deployment's network id until plan item 13 wires the
 * permitted key through `formatS3rchNetwork`. No permitted-key path exists yet, so the
 * fingerprint is the SHA-256 of the literal "s3r.ch deployment", on host s3r.ch port 443.
 * One agreed value for this deployment, not a permitted key.
 */
import { getAddress } from "viem";
import type { ChatMessage } from "./chat";
import { isFeedSource, type FeedItem } from "./feed-types";
import type { ForumMessage } from "./forum";
import { roomSoul, sameAccessor, type SeeGraph } from "./identity/check";
import { soulKeyMatches } from "./unshare";
import { sourceAccess, type AccessContext, type AccessState } from "./views-access";
import { chatRow, feedRow, feedSourceRef, forumRow, forumSourceRef, roomSourceRef, type ViewRow } from "./views-adapters";
import type { ObservedRow } from "./views-decorators";
import { settleView } from "./views-layout";
import { shortOwner, type PickerSource } from "./views-picker";
import { formatCanonical, formatS3rchNetwork, sameSource, type Result, type SourceRef } from "./views-source-ref";
import type { View } from "./views-window";

/** SHA-256("s3r.ch deployment"). Stand-in fingerprint until plan item 13. */
export const DEPLOYMENT_KEY_FINGERPRINT = "f82e13c75fe6f5d64bd2e2b381ee170efe3bddb5a18bbf60425647d2469862f3";

function deploymentNetwork(): string {
  const formatted = formatS3rchNetwork("s3r.ch", 443, DEPLOYMENT_KEY_FINGERPRINT);
  if (!formatted.ok) throw new Error("deployment network is invalid");
  return formatted.value;
}

/** This deployment. Access checks and the Browse tree group local rooms and channels under it. */
export const DEPLOYMENT_SELF_NETWORK = deploymentNetwork();

/** Newest rows kept for one source. Older rows are dropped on the next batch. */
export const ROWS_PER_SOURCE = 200;

export type Stop = () => void;

export type SubscriptionSet = {
  /**
   * Start sources that are new and stop sources that left. A start that returns null is retried next time.
   * `live` false stops a running source and leaves it unstarted, so it can begin again when it becomes live.
   */
  sync(sources: readonly SourceRef[], live?: (ref: SourceRef) => boolean): void;
  /** Stop these sources now. A later sync can start them again. */
  halt(keys: readonly string[]): void;
  stopAll(): void;
  active(): string[];
};

/** Sources currently placed in the View, one entry per source. */
export function sourcesOfView(view: View | null): SourceRef[] {
  if (!view) return [];
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const viewWindow of view.windows) {
    for (const ref of viewWindow.sources) {
      const key = formatCanonical(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
    }
  }
  return out;
}

/**
 * Track start/stop for the sources in a View. `start` owns the transport (room chat, forum
 * poll, feed fetch) and returns a stop function, or null when it cannot start yet.
 */
export function createSubscriptionSet(start: (ref: SourceRef) => Stop | null): SubscriptionSet {
  const current = new Map<string, Stop>();
  return {
    sync(sources, live = () => true) {
      const want = new Map<string, SourceRef>();
      for (const ref of sources) want.set(formatCanonical(ref), ref);
      for (const [key, stop] of current) {
        const ref = want.get(key);
        if (ref && live(ref)) continue;
        stop();
        current.delete(key);
      }
      for (const [key, ref] of want) {
        if (current.has(key) || !live(ref)) continue;
        const stop = start(ref);
        if (stop) current.set(key, stop);
      }
    },
    halt(keys) {
      for (const key of keys) {
        const stop = current.get(key);
        if (!stop) continue;
        stop();
        current.delete(key);
      }
    },
    stopAll() {
      for (const stop of current.values()) stop();
      current.clear();
    },
    active() {
      return [...current.keys()].sort();
    },
  };
}

/** Point the subscription set at the sources in this View. */
export function syncViewSubscriptions(set: SubscriptionSet, view: View | null): void {
  set.sync(sourcesOfView(view));
}

/**
 * Merge one source's latest batch. Rows still present keep the time they were first seen;
 * new rows are stamped `now` (Unix seconds). The result is the newest `limit` rows.
 * `incoming` is the full set the subscription currently has, not a delta.
 */
export function observeSource(
  prev: readonly ObservedRow[],
  incoming: readonly ViewRow[],
  now: number,
  limit = ROWS_PER_SOURCE,
): ObservedRow[] {
  const seen = new Map<string, number>();
  for (const row of prev) seen.set(row.row.key, row.observedAt);
  const byKey = new Map<string, ObservedRow>();
  for (const row of incoming) {
    byKey.set(row.key, { row, observedAt: seen.get(row.key) ?? now });
  }
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  return [...byKey.values()]
    .sort((a, b) => b.row.ts - a.row.ts || b.observedAt - a.observedAt || (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0))
    .slice(0, cap);
}

export function rowsForChat(ref: SourceRef, messages: readonly ChatMessage[]): ViewRow[] {
  const out: ViewRow[] = [];
  for (const message of messages) {
    const row = chatRow(ref, message);
    if (row) out.push(row);
  }
  return out;
}

export function rowsForForum(ref: SourceRef, messages: readonly ForumMessage[]): ViewRow[] {
  const out: ViewRow[] = [];
  for (const message of messages) {
    const row = forumRow(ref, message);
    if (row) out.push(row);
  }
  return out;
}

/** Items that belong to this feed, through `feedRow`. */
export function rowsForFeed(ref: SourceRef, items: readonly FeedItem[], selfNetwork: string): ViewRow[] {
  const out: ViewRow[] = [];
  for (const item of items) {
    const found = feedSourceOf(item, selfNetwork);
    if (!found || !sameSource(found.ref, ref)) continue;
    const row = feedRow(ref, item);
    if (row) out.push(row);
  }
  return out;
}

/**
 * Run Check for the current signed-in owner, graph and time, and drop pending marks that
 * can now be read. The route saves that View. A later graph where the source can no longer
 * be read leaves the mark off, so the window shows "Access removed".
 */
export function recheckView(view: View, ctx: AccessContext): { view: View; access: (ref: SourceRef) => AccessState } {
  const access = (ref: SourceRef) => sourceAccess(ref, ctx);
  return { view: settleView(view, access) ?? view, access };
}

/**
 * Access for sources this session has actually been given.
 * A forum channel stays checked-when-opened until it is in the server catalog.
 * A native feed on this deployment stays checked-when-opened until a loaded item names it.
 * Either one is then readable, so its rows can show. Anything `sourceAccess` already decided
 * (a room, another network, a signed-out session) is unchanged.
 */
export function resolveLoadedAccess(
  ref: SourceRef,
  ctx: AccessContext,
  loaded: { channels: readonly CatalogChannel[]; items: readonly FeedItem[] },
): AccessState {
  const base = sourceAccess(ref, ctx);
  if (base.kind !== "on-open" || !ctx.me || ref.network !== ctx.selfNetwork) return base;
  if (ref.kind === "forum") {
    const authorized = loaded.channels.some((channel) => channel.id === ref.source && sameAccessor(channel.owner, ref.owner));
    return authorized ? { kind: "read", post: false } : base;
  }
  if (ref.kind === "feed") {
    const authorized = loaded.items.some((item) => {
      const found = feedSourceOf(item, ctx.selfNetwork);
      return found ? sameSource(found.ref, ref) : false;
    });
    return authorized ? { kind: "read", post: false } : base;
  }
  return base;
}

/**
 * Room objects the signed-in owner should add to the dest ACL.
 * Only a room whose validated owner is that signer, and only when the ACL does not already
 * name the room. Call after the ACL has finished loading: a load replaces the graph and
 * drops an earlier put. An object that is already present is left alone.
 */
export function roomOwnershipToRegister(
  rooms: readonly CatalogRoom[],
  me: string | undefined,
  graph: SeeGraph,
): { object: string; owner: string }[] {
  if (!me) return [];
  const out: { object: string; owner: string }[] = [];
  const seen = new Set<string>();
  for (const room of rooms) {
    if (!room.id || !room.owner) continue;
    let owner: string;
    try {
      owner = getAddress(room.owner);
    } catch {
      continue;
    }
    if (!sameAccessor(owner, me)) continue;
    const object = roomSoul(room.id);
    if (seen.has(object) || graph.hasObject(object)) continue;
    seen.add(object);
    out.push({ object, owner });
  }
  return out;
}

/** Public room chat runs only while that room is still published. Other kinds are unaffected. */
export function sourceStaysLive(ref: SourceRef, publicRoomIds: ReadonlySet<string>): boolean {
  if (ref.kind !== "chat") return true;
  return publicRoomIds.has(ref.source);
}

/** Drop a published room id, matching either the id or its mesh key. */
export function dropPublicRoom(ids: ReadonlySet<string>, roomId: string): Set<string> {
  const next = new Set<string>();
  for (const id of ids) if (!soulKeyMatches(id, roomId)) next.add(id);
  return next;
}

/** Chat sources in the View whose room was unpublished. */
export function unsharedChatKeys(sources: readonly SourceRef[], roomId: string): string[] {
  return sources.filter((ref) => ref.kind === "chat" && soulKeyMatches(ref.source, roomId)).map((ref) => formatCanonical(ref));
}

export type CatalogRoom = { id: string; owner: string; title: string };
export type CatalogChannel = { id: string; owner: string };

function labeled(result: Result<SourceRef>, label: string): { ref: SourceRef; label: string } | null {
  return result.ok ? { ref: result.value, label } : null;
}

function prefixed(value: string, prefix: string): string | null {
  return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

function atUriAuthority(uri: string): string | null {
  if (!uri.startsWith("at://")) return null;
  const rest = uri.slice("at://".length);
  const slash = rest.indexOf("/");
  const did = (slash >= 0 ? rest.slice(0, slash) : rest).trim();
  return did.startsWith("did:") ? did : null;
}

function rssFeed(feedUrl: string): { ref: SourceRef; label: string } | null {
  let url: URL;
  try {
    url = new URL(feedUrl);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash) return null;
  return labeled(feedSourceRef("rss", url.origin, url.href), url.hostname);
}

function farcasterFeed(castsUrl: string, author: string): { ref: SourceRef; label: string } | null {
  let url: URL;
  try {
    url = new URL(castsUrl);
  } catch {
    return null;
  }
  const fid = url.searchParams.get("fid") ?? "";
  if (!/^[1-9][0-9]{0,19}$/.test(fid)) return null;
  const label = author && !author.startsWith("fid:") ? author : `FID ${fid}`;
  return labeled(feedSourceRef("farcaster", fid, "casts"), label);
}

function nostrFeed(rest: string): { ref: SourceRef; label: string } | null {
  const queryAt = rest.indexOf("?");
  const pubkey = new URLSearchParams(queryAt >= 0 ? rest.slice(queryAt + 1) : "").get("authors") ?? "";
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return null;
  return labeled(feedSourceRef("nostr", pubkey, "notes"), `${pubkey.slice(0, 8)}…`);
}

function activityFeed(outboxUrl: string): { ref: SourceRef; label: string } | null {
  let url: URL;
  try {
    url = new URL(outboxUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/outbox")) return null;
  const actorPath = path.slice(0, -"/outbox".length) || "/";
  const actorUrl = new URL(url.origin);
  actorUrl.pathname = actorPath;
  const actor = actorPath !== "/" && actorUrl.href.endsWith("/") ? actorUrl.href.slice(0, -1) : actorUrl.href;
  const segment = actorPath.split("/").filter(Boolean).pop() ?? actorUrl.hostname;
  return labeled(feedSourceRef("activitypub", actor, `${url.origin}${path}`), segment);
}

/** XRPC method names sit in a dotted path (`app.bsky.feed.getFeed`), not a slash segment. */
function xrpcMethod(pathname: string, method: string): boolean {
  return pathname.endsWith(`/${method}`) || pathname.endsWith(`.${method}`);
}

function atprotoFeed(raw: string, itemId: string): { ref: SourceRef; label: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (xrpcMethod(url.pathname, "getFeed")) {
    const feed = url.searchParams.get("feed") ?? "";
    const did = atUriAuthority(feed);
    if (!did) return null;
    return labeled(feedSourceRef("atproto", did, feed), feed.split("/").pop() || "Feed");
  }
  if (xrpcMethod(url.pathname, "getAuthorFeed")) {
    const actor = url.searchParams.get("actor") ?? "";
    const did = actor.startsWith("did:") ? actor : atUriAuthority(itemId);
    if (!did) return null;
    return labeled(feedSourceRef("atproto", did, "posts"), "Posts");
  }
  return null;
}

/**
 * The feed a pulled item belongs to, using the provenance the existing fetchers write.
 * Items that do not name a stable owner are skipped.
 */
export function feedSourceOf(item: FeedItem, selfNetwork: string): { ref: SourceRef; label: string } | null {
  if (item.source === "s3rch") {
    let owner: string;
    try {
      owner = getAddress(item.author);
    } catch {
      return null;
    }
    if (owner !== item.author) return null;
    return labeled(feedSourceRef(selfNetwork, owner, "posts"), "Posts");
  }
  const provenance = item.provenance.trim();
  const rss = prefixed(provenance, "rss:") ?? prefixed(provenance, "atom:");
  if (rss) return rssFeed(rss);
  const farcaster = prefixed(provenance, "farcaster:hub:");
  if (farcaster) return farcasterFeed(farcaster, item.author);
  const nostr = prefixed(provenance, "nostr:relay:");
  if (nostr) return nostrFeed(nostr);
  const activity = prefixed(provenance, "activitypub:");
  if (activity) return activityFeed(activity);
  const atproto = prefixed(provenance, "atproto:");
  if (atproto) return atprotoFeed(atproto, item.id);
  return null;
}

function asFeedItem(value: unknown): FeedItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim()) return null;
  if (!isFeedSource(item.source)) return null;
  if (typeof item.author !== "string" || typeof item.body !== "string") return null;
  if (typeof item.ts !== "number" || !Number.isFinite(item.ts)) return null;
  const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const parsed: FeedItem = {
    id: item.id.trim(),
    source: item.source,
    kind: typeof item.kind === "string" ? item.kind : "activity",
    author: item.author,
    body: item.body,
    ts: item.ts,
    permalink: typeof item.permalink === "string" ? item.permalink : "",
    tags,
    provenance: typeof item.provenance === "string" ? item.provenance : "",
  };
  if (typeof item.v === "number") parsed.v = item.v;
  return parsed;
}

/** Items array from `GET /api/feed`. Anything else is an empty list. */
export function readFeedItems(body: unknown): FeedItem[] {
  if (!body || typeof body !== "object") return [];
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: FeedItem[] = [];
  for (const item of items) {
    const parsed = asFeedItem(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

function asChannel(value: unknown): CatalogChannel | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { id?: unknown; owner?: unknown };
  if (typeof record.id !== "string" || record.id === "" || typeof record.owner !== "string") return null;
  try {
    if (getAddress(record.owner) !== record.owner) return null;
  } catch {
    return null;
  }
  return { id: record.id, owner: record.owner };
}

function asMessage(value: unknown): ForumMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (typeof message.id !== "string" || typeof message.channel !== "string" || typeof message.owner !== "string") return null;
  if (typeof message.bot !== "string" || typeof message.body !== "string" || typeof message.ts !== "number" || typeof message.v !== "number") return null;
  return {
    id: message.id,
    channel: message.channel,
    owner: message.owner,
    bot: message.bot,
    body: message.body,
    ts: message.ts,
    v: message.v,
  };
}

function asMessages(value: unknown): ForumMessage[] {
  if (!Array.isArray(value)) return [];
  const out: ForumMessage[] = [];
  for (const entry of value) {
    const message = asMessage(entry);
    if (message) out.push(message);
  }
  return out;
}

/**
 * Channels and messages from `GET /api/forum` (the signed-in owner's channel and channels
 * shared with them). A denied body is null so the caller can keep the previous read.
 */
export function readForumCatalog(body: unknown): { channels: CatalogChannel[]; messages: ForumMessage[] } | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (record.denied === true) return null;
  const channels: CatalogChannel[] = [];
  const messages: ForumMessage[] = [];
  const own = asChannel(record.channel);
  if (own) channels.push(own);
  messages.push(...asMessages(record.messages));
  if (Array.isArray(record.shared)) {
    for (const entry of record.shared) {
      if (!entry || typeof entry !== "object") continue;
      const shared = entry as Record<string, unknown>;
      const channel = asChannel(shared.channel);
      if (channel) channels.push(channel);
      messages.push(...asMessages(shared.messages));
    }
  }
  return { channels, messages };
}

/**
 * Browse rows: rooms and forum channels on this deployment, plus feeds named by pulled items.
 * `labelFor` uses this same list.
 */
export function browseSources(input: {
  selfNetwork: string;
  rooms: readonly CatalogRoom[];
  channels: readonly CatalogChannel[];
  items: readonly FeedItem[];
}): PickerSource[] {
  const out: PickerSource[] = [];
  const seen = new Set<string>();
  const add = (source: PickerSource | null) => {
    if (!source) return;
    const key = formatCanonical(source.ref);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(source);
  };
  const rooms = new Set<string>();
  for (const room of input.rooms) {
    if (!room.id || rooms.has(room.id)) continue;
    rooms.add(room.id);
    const title = room.title.trim();
    if (!title) continue;
    add(labeled(roomSourceRef(input.selfNetwork, room), title.startsWith("#") ? title : `# ${title}`));
  }
  const channels = new Set<string>();
  for (const channel of input.channels) {
    if (!channel.id || channels.has(channel.id)) continue;
    channels.add(channel.id);
    add(labeled(forumSourceRef(input.selfNetwork, channel), `Forum · ${shortOwner(channel.owner)}`));
  }
  for (const item of input.items) {
    const found = feedSourceOf(item, input.selfNetwork);
    if (found) add(found);
  }
  out.sort((a, b) => a.label.localeCompare(b.label) || (formatCanonical(a.ref) < formatCanonical(b.ref) ? -1 : 1));
  return out;
}
