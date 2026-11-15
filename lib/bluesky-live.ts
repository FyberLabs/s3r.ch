import { ATPROTO_APPVIEW_BASE, PUBLIC_ATPROTO_SOURCES } from "./atproto";
import { publicMediaUrl } from "./feed-media";
import { fetchPublicJson } from "./public-fetch";
import type { PublicLiveStream } from "./nostr-live";

const LIVE = "app.bsky.actor.status#live";
export const BLUESKY_LIVE_STALE_SECONDS = 300;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const date = (v: unknown) => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? Date.parse(v) / 1000 : NaN;

/** Trust the configured public AppView, not an independently verified repository proof.
 * Live status embeds are links to a player's page, never assumed media URLs. */
export function blueskyLiveProjection(profile: unknown, actor: string, now: number): PublicLiveStream | null {
  if (!object(profile) || typeof profile.did !== "string" || !/^did:(plc|web):[^\s/?#]{1,256}$/.test(profile.did) ||
      (actor.startsWith("did:") ? profile.did !== actor : profile.handle !== actor)) throw Error("Unexpected Bluesky profile");
  const status = profile.status;
  if (!object(status) || status.status !== LIVE || status.isActive !== true || status.isDisabled === true ||
      (Array.isArray(profile.labels) && profile.labels.length > 0) || (Array.isArray(status.labels) && status.labels.length > 0) ||
      !object(status.record) || status.record.status !== LIVE || !object(status.embed) ||
      status.embed.$type !== "app.bsky.embed.external#view" || !object(status.embed.external)) return null;
  const starts = date(status.record.createdAt), end = date(status.expiresAt);
  if (!Number.isFinite(starts) || !Number.isFinite(end) || starts > now || end <= now || end <= starts) return null;
  const url = publicMediaUrl(status.embed.external.uri);
  if (!url || !url.startsWith("https://")) return null;
  const title = typeof status.embed.external.title === "string" ? status.embed.external.title.trim().slice(0, 256) : "";
  return { id: `bluesky:${profile.did}`, author: profile.did, title: title || "Live stream", url,
    starts, expires: Math.min(end, now + BLUESKY_LIVE_STALE_SECONDS), playback: "external" };
}

export function blueskyProfileUrl(actor: string): URL {
  const url = new URL("/xrpc/app.bsky.actor.getProfile", ATPROTO_APPVIEW_BASE);
  url.searchParams.set("actor", actor);
  return url;
}

/** Fixed site-followed authors only. Missing/inactive status removes the previous row;
 * transport failures preserve it for at most five minutes after the last observation. */
export function createBlueskyLiveDirectory(
  actors: readonly string[] = PUBLIC_ATPROTO_SOURCES.flatMap(s => s.kind === "author" ? [s.actor] : []),
  pull: (actor: string) => Promise<unknown> = actor => fetchPublicJson(blueskyProfileUrl(actor)),
  clock: () => number = Date.now,
) {
  if (actors.length > 16 || new Set(actors).size !== actors.length || actors.some(a => !a || a.length > 256 || /[\s/?#]/.test(a))) throw Error("Invalid live actors");
  const followed = [...actors], entries = new Map<string, PublicLiveStream>();
  let nextPoll = 0, pending: Promise<void> | null = null, available = false;
  async function update() {
    const results = await Promise.allSettled(followed.map(async actor => {
      const raw = await pull(actor);
      return { actor, stream: blueskyLiveProjection(raw, actor, Math.floor(clock() / 1000)) };
    }));
    available = results.some(r => r.status === "fulfilled");
    for (const result of results) if (result.status === "fulfilled") {
      const { actor, stream } = result.value;
      if (stream) entries.set(actor, stream); else entries.delete(actor);
    }
  }
  return async () => {
    if (!pending && clock() >= nextPoll) {
      nextPoll = clock() + 60_000;
      pending = update().finally(() => { pending = null; });
    }
    await pending;
    const now = Math.floor(clock() / 1000);
    for (const [actor, stream] of entries) if (stream.expires <= now) entries.delete(actor);
    return { available, streams: [...entries.values()] };
  };
}
export const publicBlueskyLiveDirectory = createBlueskyLiveDirectory();
