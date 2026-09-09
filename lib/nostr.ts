/**
 * Nostr inbound (no outbound). NIP-01 REQ on a documented public relay
 * for kind 1 notes from documented pubkeys. Server-side WebSocket on
 * the seeder / `/api/ingest`. The allowlisted extension / relay may
 * open that documented `wss` itself. Empty / failed relays write
 * nothing. Direct browser-to-source CORS is unchanged in a naked tab.
 */

import { PUBLIC_FETCH_MS } from "./public-fetch";
import type { FeedItem, SourcePull } from "./feed-types";
import { normalizeTags } from "./feed-types";
import { canonicalKey } from "./merge";
import { asString, isRecord } from "./rss3";

export const NOSTR_RELAY_URL = process.env.NOSTR_RELAY_URL ?? "wss://nos.lol";

const LIMIT = 20;
const BODY_MAX = 320;
const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Documented public kind-1 authors (hex). fiatjaf (NIP author) and Jack
 * Dorsey — well-known public keys, not a search API. Default relay is
 * nos.lol (answered unsigned REQ here). Override with NOSTR_RELAY_URL.
 */
export const PUBLIC_NOSTR_PUBKEYS = [
  "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
  "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2",
] as const;

export type NostrFilter = {
  authors: string[];
  kinds: number[];
  limit: number;
};

export function nostrPermalink(id: string): string {
  return HEX64.test(id) ? `https://njump.me/${id.toLowerCase()}` : "";
}

export function kind1Filter(pubkey: string, limit = LIMIT): NostrFilter {
  return { authors: [pubkey.toLowerCase()], kinds: [1], limit };
}

/** Parse one NIP-01 frame. EVENT for our sub → the event object; EOSE → "eose"; else null. */
export function parseNostrFrame(
  raw: unknown,
  subId: string,
): { kind: "event"; event: unknown } | { kind: "eose" } | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const type = raw[0];
  if (type === "EOSE" && raw[1] === subId) return { kind: "eose" };
  if (type === "EVENT" && raw[1] === subId && raw[2] !== undefined) {
    return { kind: "event", event: raw[2] };
  }
  return null;
}

export function normalizeNostrEvent(
  raw: unknown,
  provenance: string,
): FeedItem | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (kind !== 1) return null;
  const id = asString(raw.id);
  if (!id || !HEX64.test(id)) return null;

  const pubkey = asString(raw.pubkey) ?? "";
  const created =
    typeof raw.created_at === "number" && Number.isFinite(raw.created_at)
      ? Math.floor(raw.created_at)
      : 0;

  return {
    id: id.toLowerCase(),
    source: "nostr",
    kind: "social",
    author: pubkey.toLowerCase(),
    body: clip(asString(raw.content) ?? "", BODY_MAX),
    ts: created > 0 ? created : 0,
    permalink: nostrPermalink(id),
    tags: normalizeTags(["nostr", "social"]),
    provenance,
  };
}

export async function fetchPublicNostr(): Promise<SourcePull> {
  const results = await Promise.allSettled(
    PUBLIC_NOSTR_PUBKEYS.map((pubkey) => pullPubkey(pubkey)),
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
      sourcesTried: PUBLIC_NOSTR_PUBKEYS.length,
      error:
        "Nostr relay did not return kind 1 notes. This feed does not invent rows. " +
        (failures[0] ?? "All relay requests failed."),
    };
  }

  return {
    items,
    sourcesOk,
    sourcesTried: PUBLIC_NOSTR_PUBKEYS.length,
    error: null,
  };
}

export function nostrProvenance(relay: string, pubkey: string): string {
  return `nostr:relay:${relay}?kinds=1&authors=${pubkey.toLowerCase()}`;
}

async function pullPubkey(pubkey: string): Promise<FeedItem[]> {
  const provenance = nostrProvenance(NOSTR_RELAY_URL, pubkey);
  const events = await queryRelay(NOSTR_RELAY_URL, kind1Filter(pubkey));
  const items: FeedItem[] = [];
  for (const event of events) {
    const item = normalizeNostrEvent(event, provenance);
    if (item) items.push(item);
  }
  return items;
}

export async function queryNostrRelay(
  relay: string,
  filter: NostrFilter,
): Promise<unknown[]> {
  return queryRelay(relay, filter);
}

async function queryRelay(relay: string, filter: NostrFilter): Promise<unknown[]> {
  if (typeof WebSocket === "undefined") {
    throw new Error("Nostr pull needs WebSocket.");
  }

  const events: unknown[] = [];
  const subId = `s3rch-${Math.random().toString(16).slice(2, 10)}`;
  const ws = new WebSocket(relay);

  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (events.length > 0) {
        finish(() => resolve(events));
        return;
      }
      finish(() => reject(new Error(`${relay} timed out`)));
    }, PUBLIC_FETCH_MS);

    function finish(done: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(["CLOSE", subId]));
        }
        ws.close();
      } catch {
        /* ignore */
      }
      done();
    }

    ws.addEventListener("open", () => {
      try {
        ws.send(JSON.stringify(["REQ", subId, filter]));
      } catch (error) {
        finish(() =>
          reject(error instanceof Error ? error : new Error(`${relay} send failed`)),
        );
      }
    });

    ws.addEventListener("message", (ev) => {
      let parsed: unknown;
      try {
        const data = typeof ev.data === "string" ? ev.data : String(ev.data);
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      const frame = parseNostrFrame(parsed, subId);
      if (!frame) return;
      if (frame.kind === "event") {
        events.push(frame.event);
        return;
      }
      finish(() => resolve(events));
    });

    ws.addEventListener("error", () => {
      if (events.length > 0) {
        finish(() => resolve(events));
        return;
      }
      finish(() => reject(new Error(`${relay} WebSocket error`)));
    });

    ws.addEventListener("close", () => {
      if (settled) return;
      if (events.length > 0) {
        finish(() => resolve(events));
        return;
      }
      finish(() => reject(new Error(`${relay} closed before EOSE`)));
    });
  });
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
