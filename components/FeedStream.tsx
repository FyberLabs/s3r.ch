"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FeedItem, FeedSnapshot } from "@/lib/feed-types";
import { fromGunNode, toGunNode } from "@/lib/feed-types";
import { mergeItems } from "@/lib/merge";
import { IngestForm } from "@/components/IngestForm";
import { TagChips } from "@/components/TagChips";

type GunRef = {
  get: (key: string) => GunRef;
  put: (data: unknown) => GunRef;
  map: () => { on: (cb: (data: unknown, key: string) => void) => { off?: () => void } };
};

export function FeedStream() {
  const [seed, setSeed] = useState<FeedItem[]>([]);
  const [overlay, setOverlay] = useState<FeedItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [meta, setMeta] = useState<Omit<FeedSnapshot, "items"> | null>(null);
  const [status, setStatus] = useState("Opening Gun…");

  const hydrate = useCallback(async (gun: GunRef, items: FeedItem[]) => {
    for (const item of items) {
      gun.get("s3rch").get("items").get(safeKey(item.id)).put(toGunNode(item));
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

  const items = useMemo(() => mergeItems(seed, overlay), [seed, overlay]);
  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      for (const tag of item.tags) set.add(tag);
    }
    return Array.from(set).sort();
  }, [items]);

  const visible = useMemo(() => {
    if (selected.length === 0) return items;
    return items.filter((item) => item.tags.some((tag) => selected.includes(tag)));
  }, [items, selected]);

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

      <TagChips tags={tags} selected={selected} onChange={setSelected} />

      <IngestForm
        onItems={(next) => setOverlay((prev) => mergeItems(prev, next))}
      />

      {visible.length === 0 ? (
        <p className="mt-8 rounded-xl border border-brand-100 bg-brand-50/40 p-6 text-sm text-gray-600">
          No items in this Gun graph
          {selected.length ? " for the selected tags" : ""}. Empty sources stay
          empty.
        </p>
      ) : (
        <ul className="mt-8 space-y-3">
          {visible.map((item) => (
            <li key={item.id}>
              <FeedCard item={item} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FeedCard({ item }: { item: FeedItem }) {
  const when = item.ts
    ? new Date(item.ts * 1000).toISOString().replace(".000Z", "Z")
    : null;
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

function safeKey(id: string): string {
  return id.replace(/[.#$[\]]/g, "_");
}
