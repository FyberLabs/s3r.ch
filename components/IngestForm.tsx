"use client";

import { useState } from "react";
import type { FeedItem } from "@/lib/feed-types";
import { btnPrimary, field, panel } from "@/lib/brand-ui";

export function IngestForm({
  onItems,
}: {
  onItems: (items: FeedItem[]) => void;
}) {
  const [rssUrl, setRssUrl] = useState("");
  const [rss3Account, setRss3Account] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(kind: "rss" | "rss3") {
    setBusy(true);
    setMessage(null);
    try {
      const body =
        kind === "rss"
          ? { rssUrl: rssUrl.trim() }
          : { rss3Account: rss3Account.trim() };
      const response = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        items?: FeedItem[];
        error?: string | null;
      };
      const items = payload.items ?? [];
      if (items.length) {
        onItems(items);
        setMessage(`Merged ${items.length} item${items.length === 1 ? "" : "s"} onto your local Gun graph.`);
      } else {
        setMessage(payload.error || "Nothing to merge.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Ingest failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`mt-10 ${panel}`}>
      <h2 className="text-sm font-semibold text-ink">Your overlay</h2>
      <p className="mt-2 text-sm text-ink-muted">
        Pull a public RSS/Atom URL or an RSS3 address. Items are normalized to
        the same shape and merged in your browser Gun graph. They are not
        written into the public seed.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block text-sm text-ink">
          RSS / Atom URL
          <div className="mt-1 flex gap-2">
            <input
              type="url"
              value={rssUrl}
              onChange={(event) => setRssUrl(event.target.value)}
              placeholder="https://example.com/feed.xml"
              className={`w-full ${field}`}
            />
            <button
              type="button"
              disabled={busy || !rssUrl.trim()}
              onClick={() => submit("rss")}
              className={`shrink-0 ${btnPrimary}`}
            >
              Pull
            </button>
          </div>
        </label>
        <label className="block text-sm text-ink">
          RSS3 address
          <div className="mt-1 flex gap-2">
            <input
              type="text"
              value={rss3Account}
              onChange={(event) => setRss3Account(event.target.value)}
              placeholder="0x… or name.eth"
              className={`w-full ${field}`}
            />
            <button
              type="button"
              disabled={busy || !rss3Account.trim()}
              onClick={() => submit("rss3")}
              className={`shrink-0 ${btnPrimary}`}
            >
              Pull
            </button>
          </div>
        </label>
      </div>
      {message ? <p className="mt-3 text-xs text-ink-muted">{message}</p> : null}
    </div>
  );
}
