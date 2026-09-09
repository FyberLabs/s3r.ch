"use client";

import { useEffect, useState } from "react";
import type { FeedItem } from "@/lib/feed-types";
import {
  canOutboundPost,
  type OutboundNetworkId,
  type OutboundStatusRow,
} from "@/lib/outbound";
import type { OutboundResult } from "@/lib/bridges";
import { useIdentitySession } from "@/components/useIdentitySession";
import { btnSecondary } from "@/lib/brand-ui";

export const POST_TO_FARCASTER_COPY = "Post to Farcaster";
export const POST_TO_BLUESKY_COPY = "Post to Bluesky";
export const CONFIRM_FARCASTER_COPY = "Confirm Farcaster";
export const CONFIRM_BLUESKY_COPY = "Confirm Bluesky";

const LABELS: Record<
  OutboundNetworkId,
  { action: string; confirm: string }
> = {
  farcaster: { action: POST_TO_FARCASTER_COPY, confirm: CONFIRM_FARCASTER_COPY },
  atproto: { action: POST_TO_BLUESKY_COPY, confirm: CONFIRM_BLUESKY_COPY },
};

export function OutboundPostControls({ item }: { item: FeedItem }) {
  const session = useIdentitySession();
  const [status, setStatus] = useState<OutboundStatusRow[] | null>(null);
  const [confirm, setConfirm] = useState<OutboundNetworkId | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!session) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    void fetch("/api/outbound", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { adapters?: OutboundStatusRow[] };
        if (!cancelled && Array.isArray(payload.adapters)) {
          setStatus(payload.adapters);
        }
      })
      .catch(() => {
        /* keep buttons; POST still fails closed */
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (!session || !canOutboundPost(item, session.address)) return null;

  async function publish(network: OutboundNetworkId) {
    if (confirm !== network) {
      setConfirm(network);
      setMessage(null);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/outbound", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          network,
          item: {
            id: item.id,
            source: item.source,
            kind: item.kind,
            author: item.author,
            body: item.body,
            permalink: item.permalink,
            tags: item.tags,
          },
        }),
      });
      const payload = (await response.json()) as OutboundResult & { error?: string };
      if (payload.ok) {
        setMessage("Posted.");
        setConfirm(null);
        return;
      }
      setMessage(payload.reason || payload.error || "Could not post.");
      setConfirm(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not post.");
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 border-t border-rule pt-3">
      <div className="flex flex-wrap gap-2">
        {(["farcaster", "atproto"] as const).map((network) => {
          const row = status?.find((entry) => entry.id === network);
          const label = LABELS[network];
          return (
            <button
              key={network}
              type="button"
              disabled={busy}
              title={row && !row.enabled ? `${label.action} is not configured.` : undefined}
              onClick={() => void publish(network)}
              className={btnSecondary}
            >
              {confirm === network ? label.confirm : label.action}
            </button>
          );
        })}
      </div>
      {message ? <p className="mt-2 text-xs text-ink-muted">{message}</p> : null}
    </div>
  );
}
