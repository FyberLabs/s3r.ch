/**
 * Farcaster Hubble HTTP (no API key).
 * Default hub: https://hub.pinata.cloud
 *
 * Channel parent URLs (warpcast.com / farcaster.xyz /~/channel/… and
 * documented FIP-2 chain:// parents) returned empty messages when probed
 * 2026-08-31 / 2026-09-01. Public seed uses protocol FIDs 1, 2, 3 instead.
 */

import type { FeedItem, SourcePull } from "./feed-types";
import { normalizeTags } from "./feed-types";
import { canonicalKey } from "./merge";
import { fetchPublic } from "./public-fetch";
import { asString, isRecord } from "./rss3";

export const FARCASTER_HUB_BASE =
  process.env.FARCASTER_HUB_BASE ?? "https://hub.pinata.cloud";

/** 2021-01-01 UTC. Hub `data.timestamp` is seconds since this epoch. */
export const FARCASTER_EPOCH_UNIX = 1_609_459_200;

/** Documented public protocol FIDs. Live on Pinata Hubble as of 2026-09-01. */
export const PUBLIC_FIDS = [1, 2, 3] as const;

const PAGE_SIZE = 20;
const BODY_MAX = 320;

export type HubCastMessage = {
  hash?: string;
  data?: {
    type?: string;
    fid?: number;
    timestamp?: number;
    castAddBody?: {
      text?: string;
    };
  };
};

export function farcasterTsToUnix(timestamp: number): number {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  const seconds = Math.floor(timestamp);
  return seconds >= FARCASTER_EPOCH_UNIX ? seconds : seconds + FARCASTER_EPOCH_UNIX;
}

export function castPermalink(username: string | null, hash: string): string {
  const id = hash.startsWith("0x") ? hash : `0x${hash}`;
  if (username) return `https://farcaster.xyz/${username}/${id}`;
  return `https://farcaster.xyz/~/conversations/${id}`;
}

export function usernameFromUserData(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.messages)) return null;
  for (const message of body.messages) {
    if (!isRecord(message) || !isRecord(message.data)) continue;
    const userData = isRecord(message.data.userDataBody) ? message.data.userDataBody : null;
    if (!userData) continue;
    const type = asString(userData.type);
    if (type === "USER_DATA_TYPE_USERNAME") {
      return asString(userData.value);
    }
  }
  return null;
}

export function normalizeHubCast(
  message: HubCastMessage,
  username: string | null,
  provenance: string,
): FeedItem | null {
  const data = message.data;
  if (!data || data.type !== "MESSAGE_TYPE_CAST_ADD") return null;
  const hash = asString(message.hash);
  if (!hash) return null;

  const fid = typeof data.fid === "number" && Number.isFinite(data.fid) ? data.fid : null;
  const text = asString(data.castAddBody?.text) ?? "";
  const author = username || (fid !== null ? `fid:${fid}` : "");

  return {
    id: hash,
    source: "farcaster",
    kind: "social",
    author,
    body: clip(text, BODY_MAX),
    ts: typeof data.timestamp === "number" ? farcasterTsToUnix(data.timestamp) : 0,
    permalink: castPermalink(username, hash),
    tags: normalizeTags(["farcaster", "social"]),
    provenance,
  };
}

export async function fetchPublicCasts(): Promise<SourcePull> {
  const results = await Promise.allSettled(PUBLIC_FIDS.map((fid) => pullFid(fid)));

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
      sourcesTried: PUBLIC_FIDS.length,
      error:
        "Farcaster hub did not return casts. This feed does not invent rows. " +
        (failures[0] ?? "All hub requests failed."),
    };
  }

  return {
    items,
    sourcesOk,
    sourcesTried: PUBLIC_FIDS.length,
    error: null,
  };
}

async function pullFid(fid: number): Promise<FeedItem[]> {
  const castsUrl = castsByFidUrl(fid);
  const provenance = `farcaster:hub:${castsUrl}`;
  const [castsBody, username] = await Promise.all([
    fetchJson(castsUrl),
    fetchUsername(fid),
  ]);

  const messages = Array.isArray(castsBody.messages) ? castsBody.messages : null;
  if (!messages) {
    throw new Error(`castsByFid fid=${fid} unexpected payload`);
  }

  const items: FeedItem[] = [];
  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    const item = normalizeHubCast(raw as HubCastMessage, username, provenance);
    if (item) items.push(item);
  }
  return items;
}

async function fetchUsername(fid: number): Promise<string | null> {
  try {
    const body = await fetchJson(`${FARCASTER_HUB_BASE}/v1/userDataByFid?fid=${fid}`);
    return usernameFromUserData(body);
  } catch {
    return null;
  }
}

function castsByFidUrl(fid: number): string {
  const url = new URL("/v1/castsByFid", FARCASTER_HUB_BASE);
  url.searchParams.set("fid", String(fid));
  url.searchParams.set("pageSize", String(PAGE_SIZE));
  url.searchParams.set("reverse", "true");
  return url.toString();
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetchPublic(url);
  if (!response.ok) {
    throw new Error(`${url} HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body)) {
    throw new Error(`${url} unexpected payload`);
  }
  return body;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
