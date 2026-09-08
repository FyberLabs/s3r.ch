"use client";

import { useState } from "react";
import {
  ALLOWED_SOURCE_CLASSES,
  ALLOWED_SOURCE_LABELS,
  BROWSER_PULL_MINE_COPY,
  BROWSER_PULL_SHARE_COPY,
  admitPulledItems,
  type AllowedSourceClass,
} from "@/lib/browser-pull";
import type { FeedItem } from "@/lib/feed-types";
import { btnPrimary, btnSecondary, field, panel } from "@/lib/brand-ui";
import { useSeeAcl } from "@/components/SeeAclProvider";
import { useIdentitySession } from "@/components/useIdentitySession";

export function IngestForm({
  onItems,
  onShareIntoMesh,
}: {
  onItems: (items: FeedItem[]) => void;
  onShareIntoMesh?: (items: FeedItem[]) => void | Promise<void>;
}) {
  const session = useIdentitySession();
  const see = useSeeAcl();
  const [rssUrl, setRssUrl] = useState("");
  const [rss3Account, setRss3Account] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lastAdmitted, setLastAdmitted] = useState<FeedItem[]>([]);
  const [confirmShare, setConfirmShare] = useState(false);

  async function submitOverlay(kind: "rss" | "rss3") {
    setBusy(true);
    setMessage(null);
    setConfirmShare(false);
    setLastAdmitted([]);
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
        setMessage(`Pulled ${items.length} item${items.length === 1 ? "" : "s"} onto Mine.`);
      } else {
        setMessage(payload.error || "Nothing to merge.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Ingest failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submitAllowed(allowedSource: AllowedSourceClass) {
    setBusy(true);
    setMessage(null);
    setConfirmShare(false);
    setLastAdmitted([]);
    try {
      if (!session || !see?.acl) {
        setMessage("Sign in with Ethereum to pull allowed sources.");
        return;
      }
      const response = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowedSource }),
      });
      const payload = (await response.json()) as {
        items?: FeedItem[];
        error?: string | null;
      };
      const items = payload.items ?? [];
      if (!items.length) {
        setMessage(payload.error || "Nothing to merge.");
        return;
      }
      const admitted = admitPulledItems(see.acl, items, session.address);
      if (!admitted.length) {
        setMessage("Could not admit those items.");
        return;
      }
      onItems(admitted);
      setLastAdmitted(admitted);
      await see.persist();
      setMessage(
        `Merged ${admitted.length} item${admitted.length === 1 ? "" : "s"} onto Mine. ${BROWSER_PULL_MINE_COPY}`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Pull failed.");
    } finally {
      setBusy(false);
    }
  }

  async function shareLastPull() {
    if (!lastAdmitted.length || !onShareIntoMesh) return;
    if (!confirmShare) {
      setConfirmShare(true);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await onShareIntoMesh(lastAdmitted);
      setConfirmShare(false);
      setMessage(`Shared ${lastAdmitted.length} item${lastAdmitted.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Share failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`mt-10 ${panel}`}>
      <h2 className="text-sm font-semibold text-ink">Your overlay</h2>
      <p className="mt-2 text-sm text-ink-muted">
        Pull a public feed onto Mine. Share if you want it public.
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
              onClick={() => void submitOverlay("rss")}
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
              onClick={() => void submitOverlay("rss3")}
              className={`shrink-0 ${btnPrimary}`}
            >
              Pull
            </button>
          </div>
        </label>
      </div>

      <div className="mt-6 border-t border-rule pt-4">
        <h3 className="text-sm font-semibold text-ink">Allowed lab sources</h3>
        <p className="mt-2 text-sm text-ink-muted">
          Pull the same public sources the lab feed uses.
        </p>
        {session ? (
          <>
            <div className="mt-3 flex flex-wrap gap-2">
              {ALLOWED_SOURCE_CLASSES.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  disabled={busy}
                  onClick={() => void submitAllowed(kind)}
                  className={btnSecondary}
                >
                  Pull {ALLOWED_SOURCE_LABELS[kind]}
                </button>
              ))}
            </div>
            {lastAdmitted.length && onShareIntoMesh ? (
              <div className="mt-3">
                <p className="text-xs text-ink-muted">{BROWSER_PULL_SHARE_COPY}</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void shareLastPull()}
                  className={`mt-2 ${btnSecondary}`}
                >
                  {confirmShare ? "Confirm share" : "Share to public"}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <p className="mt-3 text-xs text-ink-muted">
            Sign in with Ethereum to pull those sources.
          </p>
        )}
      </div>
      {message ? <p className="mt-3 text-xs text-ink-muted">{message}</p> : null}
    </div>
  );
}
