"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useBrand } from "@/components/brand";
import {
  isFeedSource,
  isUnshareMarker,
  type FeedItem,
  type FeedSource,
} from "@/lib/feed-types";

const SOURCE_LABEL: Record<FeedSource, string> = {
  farcaster: "Farcaster",
  atproto: "Bluesky",
  nostr: "Nostr",
  activitypub: "ActivityPub",
  rss: "RSS",
  atom: "Atom",
  rss3: "RSS3",
  s3rch: "s3r.ch",
};

const PREVIEW_LIMIT = 6;

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function isPreviewItem(value: unknown): value is FeedItem {
  if (!value || typeof value !== "object") return false;
  if (isUnshareMarker((value as { unshared?: unknown }).unshared)) return false;
  const row = value as Partial<FeedItem>;
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    typeof row.body === "string" &&
    isFeedSource(row.source) &&
    typeof row.author === "string" &&
    typeof row.ts === "number"
  );
}

function previewItems(items: readonly FeedItem[]): FeedItem[] {
  const live = items.filter((item) => item.body.trim().length > 0);
  const picked: FeedItem[] = [];
  const seen = new Set<FeedSource>();
  for (const item of live) {
    if (seen.has(item.source)) continue;
    seen.add(item.source);
    picked.push(item);
    if (picked.length >= PREVIEW_LIMIT) return picked;
  }
  for (const item of live) {
    if (picked.some((row) => row.id === item.id)) continue;
    picked.push(item);
    if (picked.length >= PREVIEW_LIMIT) break;
  }
  return picked;
}

function when(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toISOString().replace(".000Z", "Z");
}

function sourceHref(permalink: string | undefined): string | null {
  if (!permalink) return null;
  if (permalink.startsWith("https://") || permalink.startsWith("http://")) return permalink;
  return null;
}

export function PublicFeedPreview() {
  const { reader } = useBrand();
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [items, setItems] = useState<FeedItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/feed", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { items?: unknown } | null) => {
        if (cancelled) return;
        const rows = Array.isArray(body?.items) ? body.items.filter(isPreviewItem) : [];
        setItems(previewItems(rows));
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setItems([]);
          setStatus("ready");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "loading") {
    return <p className="mt-6 text-sm text-ink-muted">Loading public posts…</p>;
  }

  if (items.length === 0) {
    return (
      <p className="mt-6 text-sm text-ink-muted">
        No public posts in this snapshot yet.{" "}
        <Link href="/feed" className="font-semibold text-ink hover:text-signal">
          Open feed
        </Link>
      </p>
    );
  }

  const open = (
    <p className="mt-6 text-sm text-ink-muted">
      <Link href="/feed" className="font-semibold text-ink hover:text-signal">
        Open feed
      </Link>
    </p>
  );

  if (reader === "ai") {
    return (
      <div className="mt-6 overflow-x-auto">
        <table className="brand-table">
          <thead>
            <tr>
              <th scope="col">source</th>
              <th scope="col">author</th>
              <th scope="col">body</th>
              <th scope="col">when</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{SOURCE_LABEL[item.source]}</td>
                <td>{clip(item.author, 48)}</td>
                <td className="whitespace-normal">{clip(item.body, 180)}</td>
                <td className="font-data">{when(item.ts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {open}
      </div>
    );
  }

  return (
    <div className="mt-6">
      <ul className="grid gap-3">
        {items.map((item) => {
          const href = sourceHref(item.permalink);
          return (
            <li key={item.id} className="border border-rule bg-panel p-4">
              <p className="text-xs font-semibold text-signal">{SOURCE_LABEL[item.source]}</p>
              <p className="mt-2 text-sm text-ink">{clip(item.body, 180)}</p>
              <p className="mt-2 text-xs text-ink-muted">
                {clip(item.author, 48)}
                {item.ts ? <span className="font-data"> · {when(item.ts)}</span> : null}
                {href ? (
                  <>
                    {" · "}
                    <a href={href} target="_blank" rel="noopener noreferrer" className="hover:text-ink">
                      Original
                    </a>
                  </>
                ) : null}
              </p>
            </li>
          );
        })}
      </ul>
      {open}
    </div>
  );
}
