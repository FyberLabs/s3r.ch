import { PUBLIC_ACTIVITYPUB_ACTORS } from "./activitypub";
import { fetchActivityPubObject } from "./activitypub-conversation";
import { publicMediaUrl } from "./feed-media";
import type { PublicLiveStream } from "./nostr-live";

export const ACTIVITYPUB_LIVE_STALE_SECONDS = 300;
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const reference = (value: unknown) => typeof value === "string" ? value : record(value).id;
function localUrl(value: unknown, actor: string): string | null {
  const url = publicMediaUrl(value);
  return url && url.startsWith("https://") && new URL(url).origin === new URL(actor).origin ? url : null;
}

/** PeerTube's Video extension only. HTTPS origin retrieval is the authority;
 * neither embedded outbox objects nor JSON-LD signature claims are trusted. */
export function activityPubLiveProjection(raw: unknown, actor: string, id: string, now: number): PublicLiveStream | null {
  const video = record(raw);
  const authors = Array.isArray(video.attributedTo) ? video.attributedTo : [video.attributedTo];
  const audience = [video.to, video.cc].flatMap(value => Array.isArray(value) ? value : [value]);
  if (video.id !== id || !localUrl(id, actor) || video.type !== "Video" ||
      !authors.some(value => reference(value) === actor) || !audience.includes(PUBLIC) ||
      video.isLiveBroadcast !== true || video.state !== 1 || video.sensitive !== false ||
      (Array.isArray(video.tag) && video.tag.some(tag => record(tag).type === "SensitiveTag"))) return null;
  const title = typeof video.name === "string" ? video.name.trim().slice(0, 256) : "";
  // A permanent live video's creation/publication date is not its current start.
  // Do not turn cumulative views into a current viewer count or load thumbnails.
  return { id: `activitypub:${id}`, author: actor, title: title || "Live stream", url: id,
    playback: "external", timeBasis: "observed", starts: now, expires: now + ACTIVITYPUB_LIVE_STALE_SECONDS };
}

function collectionRows(raw: unknown): unknown[] | null {
  const value = record(raw);
  if (!["Collection", "OrderedCollection", "CollectionPage", "OrderedCollectionPage"].includes(String(value.type)))
    throw Error("Invalid live collection");
  const rows = value.orderedItems ?? value.items;
  if (Array.isArray(rows)) return rows.slice(0, 20);
  if (value.totalItems === 0) return [];
  return null;
}

/** At most one outbox page and four canonical videos per actor. New discovery
 * replaces that actor's window; this is not complete or durable live history. */
export async function pullActivityPubLive(actor: string, pull = fetchActivityPubObject, clock = Date.now) {
  const started = clock();
  const read = async (url: string) => {
    if (clock() - started >= 30_000) throw Error("Live discovery deadline");
    return pull(url);
  };
  const source = record(await read(actor));
  if (source.id !== actor || !["Person", "Group", "Service", "Organization"].includes(String(source.type)))
    throw Error("Unexpected live actor");
  const outbox = localUrl(reference(source.outbox), actor);
  if (!outbox) throw Error("Invalid live outbox");
  let collection = record(await read(outbox));
  let rows = collectionRows(collection);
  if (rows === null) {
    const first = localUrl(reference(collection.first), actor);
    if (!first) throw Error("Missing live outbox page");
    collection = record(await read(first));
    rows = collectionRows(collection);
    if (rows === null) throw Error("Incomplete live outbox page");
  }
  const ids = new Set<string>();
  for (const raw of rows) {
    const row = record(raw);
    if (!["Create", "Update", "Announce"].includes(String(row.type)) || reference(row.actor) !== actor) continue;
    const id = localUrl(reference(row.object), actor);
    if (id) ids.add(id);
    if (ids.size === 4) break;
  }
  // A failed canonical lookup fails the observation; the cache may retain only
  // its already bounded previous window, never extend it from embedded metadata.
  const videos = await Promise.all([...ids].map(async id => ({ id, raw: await read(id) })));
  const now = Math.floor(clock() / 1000);
  return videos.flatMap(({ id, raw }) => {
    const stream = activityPubLiveProjection(raw, actor, id, now);
    return stream ? [stream] : [];
  });
}

export function createActivityPubLiveDirectory(
  actors: readonly string[] = PUBLIC_ACTIVITYPUB_ACTORS,
  pull = fetchActivityPubObject,
  clock = Date.now,
) {
  if (actors.length > 4 || new Set(actors).size !== actors.length || actors.some(actor => localUrl(actor, actor) !== actor))
    throw Error("Invalid live actors");
  const followed = [...actors], entries = new Map<string, PublicLiveStream[]>();
  let nextPoll = 0, pending: Promise<void> | null = null, available = false;
  async function update() {
    const results = await Promise.allSettled(followed.map(async actor => ({ actor, streams: await pullActivityPubLive(actor, pull, clock) })));
    available = results.some(result => result.status === "fulfilled");
    for (const result of results) if (result.status === "fulfilled") entries.set(result.value.actor, result.value.streams);
  }
  return async () => {
    if (!pending && clock() >= nextPoll) {
      nextPoll = clock() + 60_000;
      pending = update().finally(() => { pending = null; });
    }
    await pending;
    const now = Math.floor(clock() / 1000);
    for (const [actor, streams] of entries) entries.set(actor, streams.filter(stream => stream.expires > now));
    return { available, streams: [...entries.values()].flat() };
  };
}

export const publicActivityPubLiveDirectory = createActivityPubLiveDirectory();
