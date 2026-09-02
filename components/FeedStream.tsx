"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeedItem, FeedSnapshot, FeedTab } from "@/lib/feed-types";
import { fromGunNode, toGunNode } from "@/lib/feed-types";
import { mergeItems } from "@/lib/merge";
import { rankFeedItems } from "@/lib/feed-rank";
import { itemsForTab } from "@/lib/feed-tabs";
import { ownsNativePost, prepareShareIntoMesh } from "@/lib/compose";
import { encodeKey } from "@/lib/identity/check";
import { ComposeForm } from "@/components/ComposeForm";
import { IngestForm } from "@/components/IngestForm";
import { PostSeeGrantControls } from "@/components/PostSeeGrantControls";
import { TagChips } from "@/components/TagChips";
import { useSeeAcl } from "@/components/SeeAclProvider";
import { useIdentitySession } from "@/components/useIdentitySession";

type GunRef = {
  get: (key: string) => GunRef;
  put: (data: unknown) => GunRef;
  map: () => { on: (cb: (data: unknown, key: string) => void) => { off?: () => void } };
};

export function FeedStream() {
  const session = useIdentitySession();
  const see = useSeeAcl();
  const gunRef = useRef<GunRef | null>(null);
  const [seed, setSeed] = useState<FeedItem[]>([]);
  const [overlay, setOverlay] = useState<FeedItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [tab, setTab] = useState<Exclude<FeedTab, "network">>("public");
  const [meta, setMeta] = useState<Omit<FeedSnapshot, "items"> | null>(null);
  const [status, setStatus] = useState("Opening Gun…");
  const [sharedIds, setSharedIds] = useState<string[]>([]);
  const [confirmShareId, setConfirmShareId] = useState<string | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);

  const hydrate = useCallback(async (gun: GunRef, items: FeedItem[]) => {
    for (const item of items) {
      gun.get("s3rch").get("items").get(encodeKey(item.id)).put(toGunNode(item));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let off: (() => void) | undefined;

    (async () => {
      const GunMod = await import("gun/browser");
      const Gun = (GunMod.default ?? GunMod) as unknown as (opts?: object) => GunRef;
      // Now: hydrate from the bootstrap snapshot. Mesh / /gun peers are next
      // (see docs/ARCHITECTURE.md). Do not require a live WebSocket here.
      const gun = Gun();
      gunRef.current = gun;

      let snapshot: FeedSnapshot = {
        items: [],
        seededAt: null,
        sourcesOk: 0,
        sourcesTried: 0,
        error: null,
      };
      try {
        const response = await fetch("/api/feed", { cache: "no-store" });
        snapshot = (await response.json()) as FeedSnapshot;
      } catch {
        snapshot.error = "Could not read the Gun snapshot.";
      }
      if (cancelled) return;

      setMeta({
        seededAt: snapshot.seededAt,
        sourcesOk: snapshot.sourcesOk,
        sourcesTried: snapshot.sourcesTried,
        error: snapshot.error,
      });
      await hydrate(gun, snapshot.items ?? []);

      const listener = gun.get("s3rch").get("items").map().on((data) => {
        const item = fromGunNode(
          data as Parameters<typeof fromGunNode>[0],
        );
        if (!item || cancelled) return;
        setSeed((prev) => mergeItems(prev, [item]));
      });
      off = typeof listener?.off === "function" ? () => listener.off?.() : undefined;

      if (!cancelled) {
        setStatus(
          snapshot.items?.length
            ? "Subscribed to Gun."
            : "Gun is empty. Nothing was invented.",
        );
      }
    })();

    return () => {
      cancelled = true;
      off?.();
    };
  }, [hydrate]);

  const tabItems = useMemo(() => itemsForTab(tab, seed, overlay), [tab, seed, overlay]);
  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const item of tabItems) {
      for (const tag of item.tags) set.add(tag);
    }
    return Array.from(set).sort();
  }, [tabItems]);

  const visible = useMemo(
    () => rankFeedItems(tabItems, selected),
    [tabItems, selected],
  );

  const published = useMemo(() => {
    const ids = new Set(sharedIds);
    for (const item of seed) ids.add(item.id);
    return ids;
  }, [seed, sharedIds]);

  function selectTab(next: Exclude<FeedTab, "network">) {
    setTab(next);
    setSelected([]);
    setShareMessage(null);
    setConfirmShareId(null);
  }

  async function shareToPublic(item: FeedItem) {
    setShareMessage(null);
    if (!session || !see?.acl) {
      setShareMessage("Could not share this post.");
      return;
    }
    if (confirmShareId !== item.id) {
      setConfirmShareId(item.id);
      return;
    }
    const prepared = prepareShareIntoMesh(see.acl, item, session.address);
    if ("denied" in prepared) {
      setShareMessage("Could not admit this post.");
      setConfirmShareId(null);
      return;
    }
    const gun = gunRef.current;
    if (!gun) {
      setShareMessage("Gun is not open yet.");
      return;
    }
    gun.get("s3rch").get("items").get(prepared.key).put(prepared.node);
    setSharedIds((prev) => (prev.includes(item.id) ? prev : [...prev, item.id]));
    setConfirmShareId(null);
    setShareMessage("Published to the public graph. One-way here.");
    await see.persist();
  }

  return (
    <div>
      <p className="mt-6 text-xs text-gray-400">
        {status}
        {meta?.seededAt ? ` · seeded ${meta.seededAt}` : ""}
        {meta
          ? ` · sources ${meta.sourcesOk} / ${meta.sourcesTried}`
          : ""}
      </p>
      {meta?.error ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-900">
          <p className="font-semibold">Seed is empty or failed</p>
          <p className="mt-2">{meta.error}</p>
          <p className="mt-2 text-red-800">
            No rows were invented. The Gun graph only holds what the seeder wrote.
          </p>
        </div>
      ) : null}

      <ComposeForm
        onItem={(next) => setOverlay((prev) => mergeItems(prev, [next]))}
      />

      <div className="mt-8 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => selectTab("public")}
          className={`rounded-lg border px-3 py-2 text-xs font-semibold ${
            tab === "public"
              ? "border-brand-700 bg-brand-700 text-white"
              : "border-brand-100 bg-white text-brand-900 hover:border-brand-500"
          }`}
        >
          Public
        </button>
        <button
          type="button"
          onClick={() => selectTab("mine")}
          className={`rounded-lg border px-3 py-2 text-xs font-semibold ${
            tab === "mine"
              ? "border-brand-700 bg-brand-700 text-white"
              : "border-brand-100 bg-white text-brand-900 hover:border-brand-500"
          }`}
        >
          Mine
        </button>
        <button
          type="button"
          disabled
          title="later — mesh"
          className="rounded-lg border border-brand-100 px-3 py-2 text-xs font-semibold text-gray-400"
        >
          Network
        </button>
        <span className="text-xs text-gray-400">later — mesh</span>
      </div>

      <TagChips tags={tags} selected={selected} onChange={setSelected} />

      {tab === "mine" ? (
        <IngestForm
          onItems={(next) => setOverlay((prev) => mergeItems(prev, next))}
        />
      ) : null}

      {shareMessage && tab === "mine" ? (
        <p className="mt-3 text-xs text-gray-500">{shareMessage}</p>
      ) : null}

      {visible.length === 0 ? (
        <p className="mt-8 rounded-xl border border-brand-100 bg-brand-50/40 p-6 text-sm text-gray-600">
          {emptyCopy(tab, Boolean(session), selected.length > 0)}
        </p>
      ) : (
        <ul className="mt-8 space-y-3">
          {visible.map((item) => (
            <li key={item.id}>
              <FeedCard
                item={item}
                mine={tab === "mine"}
                sessionAddress={session?.address ?? null}
                shared={published.has(item.id)}
                confirmShare={confirmShareId === item.id}
                onShare={() => void shareToPublic(item)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function emptyCopy(tab: FeedTab, signedIn: boolean, tagged: boolean): string {
  if (tab === "mine" && !signedIn) {
    return "Mine is empty until you sign in. Overlay ingest and native posts stay here; they are not the public seed.";
  }
  if (tab === "mine") {
    return tagged
      ? "No Mine items for the selected tags."
      : "Mine is empty. Compose a native post or pull a URL into your overlay. Nothing was invented.";
  }
  return tagged
    ? "No items in this Gun graph for the selected tags. Empty sources stay empty."
    : "No items in this Gun graph. Empty sources stay empty.";
}

function FeedCard({
  item,
  mine,
  sessionAddress,
  shared,
  confirmShare,
  onShare,
}: {
  item: FeedItem;
  mine: boolean;
  sessionAddress: string | null;
  shared: boolean;
  confirmShare: boolean;
  onShare: () => void;
}) {
  const when = item.ts
    ? new Date(item.ts * 1000).toISOString().replace(".000Z", "Z")
    : null;
  const ownNative = mine && ownsNativePost(item, sessionAddress);
  const inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold text-brand-900">
          {item.author || item.kind}
        </h2>
        <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-brand-700">
          {item.kind}
        </span>
      </div>
      <p className="mt-1 text-sm text-gray-600">{item.body}</p>
      <p className="mt-2 text-xs text-gray-500">
        {item.tags.join(" · ")}
        {when ? ` · ${when}` : ""}
        {item.provenance ? ` · ${item.provenance}` : ""}
      </p>
    </>
  );
  const className =
    "block rounded-xl border border-brand-100 bg-gradient-to-b from-white to-brand-50/40 p-5 shadow-sm";

  if (ownNative && sessionAddress) {
    return (
      <div className={className}>
        {inner}
        <div className="mt-3 border-t border-brand-100 pt-3">
          {shared ? (
            <p className="text-xs text-gray-500">
              On the public graph. Publish is one-way here.
            </p>
          ) : (
            <>
              <p className="text-xs text-gray-500">
                Share to public publishes this item onto the public graph. A
                see-grant is not this. Publish is one-way here.
              </p>
              <button
                type="button"
                onClick={onShare}
                className="mt-2 rounded-lg border border-brand-700 px-3 py-2 text-xs font-semibold text-brand-800"
              >
                {confirmShare ? "Confirm share" : "Share to public"}
              </button>
            </>
          )}
        </div>
        <PostSeeGrantControls address={sessionAddress} itemId={item.id} />
      </div>
    );
  }

  if (item.permalink) {
    return (
      <a
        href={item.permalink}
        target="_blank"
        rel="noopener noreferrer"
        className={`${className} hover:border-brand-500`}
      >
        {inner}
      </a>
    );
  }
  return <div className={className}>{inner}</div>;
}
