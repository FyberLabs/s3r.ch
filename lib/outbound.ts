/**
 * Explicit outbound posting. Not inbound pull, not share-into-mesh,
 * not a grant, not delivery. SIWE session required at the route.
 * Credentials stay server-side. Sharing a post does not call this.
 *
 * This file is UI-safe (no hub signer / PDS clients).
 * Server routes use `createOutboundAdapters()` from outbound-adapters.ts.
 */

import { ownsNativePost } from "./compose";
import { isFeedSource, type FeedItem } from "./feed-types";
import type { OutboundAdapter, OutboundDraft, OutboundResult } from "./bridges";

export const OUTBOUND_NETWORK_IDS = ["farcaster", "atproto"] as const;
export type OutboundNetworkId = (typeof OUTBOUND_NETWORK_IDS)[number];

export const OUTBOUND_NETWORK_LABEL: Record<OutboundNetworkId, string> = {
  farcaster: "Farcaster",
  atproto: "ATProto / Bluesky",
};

export type OutboundStatusRow = {
  id: OutboundNetworkId;
  network: string;
  enabled: boolean;
};

export type OutboundItemInput = Pick<
  FeedItem,
  "id" | "source" | "kind" | "author" | "body"
> & {
  permalink?: string;
  tags?: string[];
};

export type ParsedOutboundRequest =
  | { ok: true; network: OutboundNetworkId; item: OutboundItemInput }
  | { ok: false; error: string };

export function isOutboundNetworkId(value: unknown): value is OutboundNetworkId {
  return value === "farcaster" || value === "atproto";
}

/** Own native s3r.ch post only. Pulled rows and grants cannot outbound. */
export function canOutboundPost(
  item: Pick<FeedItem, "source" | "kind" | "author" | "body">,
  address: string | null | undefined,
): boolean {
  if (!ownsNativePost(item, address)) return false;
  return Boolean(item.body.trim());
}

export function draftFromItem(item: OutboundItemInput): OutboundDraft {
  const permalink = item.permalink?.trim();
  return {
    body: item.body,
    permalink: permalink || undefined,
    tags: item.tags,
  };
}

export function parseOutboundRequest(body: unknown): ParsedOutboundRequest {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Expected JSON." };
  }
  const record = body as Record<string, unknown>;
  if (!isOutboundNetworkId(record.network)) {
    return { ok: false, error: "Unknown network." };
  }
  const itemRaw = record.item;
  if (!itemRaw || typeof itemRaw !== "object") {
    return { ok: false, error: "Send the post to publish." };
  }
  const item = itemRaw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const source = isFeedSource(item.source) ? item.source : null;
  const kind = typeof item.kind === "string" ? item.kind : "";
  const author = typeof item.author === "string" ? item.author : "";
  const text = typeof item.body === "string" ? item.body : "";
  if (!id || !source || !kind || !author) {
    return { ok: false, error: "Send the post to publish." };
  }
  if (!text.trim()) {
    return { ok: false, error: "Write something first." };
  }
  const permalink =
    typeof item.permalink === "string" ? item.permalink : undefined;
  const tags = Array.isArray(item.tags)
    ? item.tags.filter((tag): tag is string => typeof tag === "string")
    : undefined;
  return {
    ok: true,
    network: record.network,
    item: { id, source, kind, author, body: text, permalink, tags },
  };
}

export function adapterForNetwork(
  adapters: readonly OutboundAdapter[],
  network: OutboundNetworkId,
): OutboundAdapter | null {
  const label = OUTBOUND_NETWORK_LABEL[network];
  return adapters.find((adapter) => adapter.network === label) ?? null;
}

export function outboundStatus(
  adapters: readonly OutboundAdapter[],
): OutboundStatusRow[] {
  return OUTBOUND_NETWORK_IDS.map((id) => {
    const adapter = adapterForNetwork(adapters, id);
    return {
      id,
      network: OUTBOUND_NETWORK_LABEL[id],
      enabled: Boolean(adapter?.enabled),
    };
  });
}

export async function postOutbound(
  adapters: readonly OutboundAdapter[],
  network: OutboundNetworkId,
  draft: OutboundDraft,
): Promise<OutboundResult> {
  const adapter = adapterForNetwork(adapters, network);
  if (!adapter) {
    return {
      ok: false,
      network: OUTBOUND_NETWORK_LABEL[network],
      reason: "Unknown network.",
    };
  }
  return adapter.post(draft);
}
