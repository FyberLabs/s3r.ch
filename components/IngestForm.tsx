"use client";

import { useState } from "react";
import {
  ALLOWED_SOURCE_CLASSES,
  ALLOWED_SOURCE_LABELS,
  admitPulledItems,
  type AllowedSourceClass,
} from "@/lib/browser-pull";
import type { FeedItem } from "@/lib/feed-types";
import { btnPrimary, btnSecondary, field, panel } from "@/lib/brand-ui";
import { canUsePullRelay } from "@/lib/pull-relay";
import { pullRelayStatusCopy, requestPullRelay, usePullRelay } from "@/lib/pull-relay-client";
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
  const { via } = usePullRelay();
  const [rssUrl, setRssUrl] = useState("");
  const [rss3Account, setRss3Account] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lastAdmitted, setLastAdmitted] = useState<FeedItem[]>([]);
  const [confirmShare, setConfirmShare] = useState(false);
  const relayCopy = pullRelayStatusCopy(via);

  async function ingestJson(body: unknown): Promise<{
    items: FeedItem[];
    error?: string | null;
  }> {
    if (via && canUsePullRelay(body)) {
      try {
        const pulled = await requestPullRelay(body, via);
        return { items: pulled.items, error: pulled.error };
      } catch {
        /* same-origin proxy stays valid */
      }
    }
    const response = await fetch("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as {
      items?: FeedItem[];
      error?: string | null;
    };
    return { items: payload.items ?? [], error: payload.error };
  }

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
      const payload = await ingestJson(body);
      const items = payload.items;
      if (items.length) {
        onItems(items);
        setMessage(`Pulled ${items.length} item${items.length === 1 ? "" : "s"} onto Mine.`);
      } else {
        setMessage(payload.error || "Nothing to pull.");
      }
    } catch (error) {
        setMessage(error instanceof Error ? error.message : "Pull failed.");
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
        setMessage("Sign in to pull.");
        return;
      }
      const payload = await ingestJson({ allowedSource });
      const items = payload.items;
      if (!items.length) {
        setMessage(payload.error || "Nothing to pull.");
        return;
      }
      const admitted = admitPulledItems(see.acl, items, session.address);
      if (!admitted.length) {
        setMessage("Could not pull those items.");
        return;
      }
      onItems(admitted);
      setLastAdmitted(admitted);
      await see.persist();
      setMessage(
        `Pulled ${admitted.length} item${admitted.length === 1 ? "" : "s"}.`,
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
      <h2 className="text-sm font-semibold text-ink">Pull</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block text-sm text-ink">
          Feed URL
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
          Address
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
        <h3 className="text-sm font-semibold text-ink">Sources</h3>
        {session ? (
          <>
            {relayCopy ? (
              <p className="mt-3 text-xs text-ink-muted">{relayCopy}</p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {ALLOWED_SOURCE_CLASSES.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  disabled={busy}
                  onClick={() => void submitAllowed(kind)}
                  className={btnSecondary}
                >
                  {via === "extension"
                    ? `Pull ${ALLOWED_SOURCE_LABELS[kind]} via extension`
                    : via === "localhost"
                      ? `Pull ${ALLOWED_SOURCE_LABELS[kind]} via relay`
                      : `Pull ${ALLOWED_SOURCE_LABELS[kind]}`}
                </button>
              ))}
            </div>
            {lastAdmitted.length && onShareIntoMesh ? (
              <div className="mt-3">
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
            Sign in to pull.
          </p>
        )}
      </div>
      {message ? <p className="mt-3 text-xs text-ink-muted">{message}</p> : null}
    </div>
  );
}
