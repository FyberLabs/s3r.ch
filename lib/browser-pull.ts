/**
 * Browser pull of the same documented public sources the lab seeder uses.
 * `/api/ingest` is the same-origin CORS proxy — direct browser-to-source
 * still fails in a naked tab. An unpacked extension or 127.0.0.1 relay
 * (`lib/pull-relay.ts`) is an additive allowlisted fetch path, not a
 * CORS off-switch. Fetch is a handoff, not a grant. Dest re-authorizes
 * (`admitFeedNode`) before a GunFeedNode `v: 1` lands. Default is Mine
 * overlay. Explicit share-into-mesh may HAM-merge onto `s3rch/items`.
 * Do not dump every pull into the public seed.
 */

import { isNativePost } from "./compose";
import {
  GUN_PROTOCOL_V,
  fromGunNode,
  toGunNode,
  type FeedItem,
  type GunFeedNode,
} from "./feed-types";
import {
  admitFeedNode,
  encodeKey,
  itemSoul,
  type HandoffHint,
  type SeeAcl,
} from "./identity/check";

export const ALLOWED_SOURCE_CLASSES = [
  "farcaster",
  "atproto",
  "rss",
  "activitypub",
  "nostr",
  "rss3-gi",
] as const;

export type AllowedSourceClass = (typeof ALLOWED_SOURCE_CLASSES)[number];

export const BROWSER_CORS_COPY =
  "This pull uses this site as a proxy.";

export const BROWSER_PULL_MINE_COPY =
  "Pulled onto Mine. Share if you want it public.";

export const BROWSER_PULL_SHARE_COPY =
  "Share these items to public.";

export const ALLOWED_SOURCE_LABELS: Record<AllowedSourceClass, string> = {
  farcaster: "Farcaster",
  atproto: "ATProto",
  rss: "RSS / Atom",
  activitypub: "ActivityPub",
  nostr: "Nostr",
  "rss3-gi": "RSS3 GI",
};

export function isAllowedSourceClass(
  value: unknown,
): value is AllowedSourceClass {
  return (
    typeof value === "string" &&
    (ALLOWED_SOURCE_CLASSES as readonly string[]).includes(value)
  );
}

export type ParsedIngestRequest =
  | { kind: "rssUrl"; rssUrl: string }
  | { kind: "rss3Account"; rss3Account: string }
  | { kind: "allowedSource"; allowedSource: AllowedSourceClass }
  | { kind: "invalid"; error: string };

/**
 * One ingest action. RSS URL / RSS3 account stay personal overlay.
 * `allowedSource` is only the documented seeder set — not invented GI routes.
 */
export function parseIngestRequest(body: unknown): ParsedIngestRequest {
  if (!body || typeof body !== "object") {
    return { kind: "invalid", error: "Expected JSON." };
  }
  const record = body as Record<string, unknown>;
  const rssUrl = typeof record.rssUrl === "string" ? record.rssUrl.trim() : "";
  const rss3Account =
    typeof record.rss3Account === "string" ? record.rss3Account.trim() : "";
  const allowedRaw = record.allowedSource;
  const hasAllowed =
    allowedRaw !== undefined && allowedRaw !== null && allowedRaw !== "";

  const selected = [Boolean(rssUrl), Boolean(rss3Account), hasAllowed].filter(
    Boolean,
  ).length;
  if (selected > 1) {
    return {
      kind: "invalid",
      error: "Send rssUrl, rss3Account, or allowedSource — not more than one.",
    };
  }
  if (rssUrl) return { kind: "rssUrl", rssUrl };
  if (rss3Account) return { kind: "rss3Account", rss3Account };
  if (hasAllowed) {
    if (!isAllowedSourceClass(allowedRaw)) {
      return { kind: "invalid", error: "Unknown allowedSource." };
    }
    return { kind: "allowedSource", allowedSource: allowedRaw };
  }
  return { kind: "invalid", error: "Send rssUrl, rss3Account, or allowedSource." };
}

function pullHandoffHint(item: FeedItem, owner: string): HandoffHint {
  return {
    principal: owner,
    target: itemSoul(item.id),
    verb: "ingest",
    context: item.provenance,
  };
}

/**
 * Dest re-authorizes each row into a GunFeedNode `v: 1`.
 * Empty / invalid / unknown-`v` rows write nothing. A URL 200 is not see.
 */
export function admitPulledItems(
  acl: SeeAcl,
  items: readonly FeedItem[],
  owner: string,
): FeedItem[] {
  const admitted: FeedItem[] = [];
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !item.id.trim()) continue;
    const node = toGunNode(item);
    const result = admitFeedNode(acl, node, owner, pullHandoffHint(item, owner));
    if ("denied" in result) continue;
    const live = fromGunNode(node);
    if (!live) continue;
    admitted.push(live);
  }
  return admitted;
}

export type SharePulledIntoMeshResult =
  | { node: GunFeedNode; key: string }
  | { denied: true };

/**
 * Prepare an explicit share of an admitted pulled item onto `s3rch/items`.
 * Not native-post share. Not a grant. Not unshare. Not OutboundAdapter.
 */
export function prepareSharePulledIntoMesh(
  acl: SeeAcl,
  item: FeedItem,
  owner: string,
): SharePulledIntoMeshResult {
  if (isNativePost(item)) return { denied: true };
  const admitted = admitPulledItems(acl, [item], owner);
  const live = admitted[0];
  if (!live) return { denied: true };
  return {
    node: { ...toGunNode(live), unshared: null },
    key: encodeKey(live.id),
  };
}

export function pulledItemHasProtocolV1(item: FeedItem): boolean {
  return (item.v ?? GUN_PROTOCOL_V) === GUN_PROTOCOL_V;
}
