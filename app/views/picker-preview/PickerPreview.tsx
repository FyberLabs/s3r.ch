"use client";

import { useState } from "react";
import { ViewsPicker } from "@/components/ViewsPicker";
import { ViewsWindowStatus } from "@/components/ViewsWindowStatus";
import type { AccessState } from "@/lib/views-access";
import { formatCanonical, type SourceRef } from "@/lib/views-source-ref";
import type { PickerSource, PickerTab } from "@/lib/views-picker";
import type { SourceKind } from "@/lib/views-source-ref";
import type { View } from "@/lib/views-window";

const ME = "0xA1b2c3D4E5f60718293A4b5C6D7E8F9012345Aff";
const ORG = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const NET = `s3rch:https://s3r.ch:443;key=${"a".repeat(64)}`;
const LAB = `s3rch:https://lab.fyberlabs.com:443;key=${"b".repeat(64)}`;

const s = (network: string, owner: string, source: string, kind: SourceKind, label: string): PickerSource => ({ ref: { network, owner, source, kind, v: 1 }, label });

const SOURCES: PickerSource[] = [
  s(NET, ME, "build", "chat", "# build"),
  s(NET, ME, "design", "chat", "# design"),
  s(NET, ME, "announcements", "forum", "announcements"),
  s(NET, ORG, "ops", "chat", "# ops"),
  s(NET, ORG, "releases", "forum", "releases"),
  s(NET, ORG, "finance", "chat", "# finance"),
  s(LAB, ORG, "lab-bench", "chat", "# lab-bench"),
  s("farcaster", "3", "dev", "feed", "/dev"),
  s("atproto", "did:plc:ewvi7nxzyoun6zhxrhs64oiz", "posts", "feed", "@alice.bsky.social"),
  s("rss", "https://hn.example", "https://hn.example/rss", "feed", "hn.example"),
];

const VIEW: View = {
  id: "dev",
  title: "Dev + streams",
  v: 1,
  windows: [
    { id: "w-build", kind: "chat", mode: "single", label: "build-chat", sources: [SOURCES[0]!.ref] },
    { id: "w-news", kind: "feed", mode: "merged", label: "News", sources: [SOURCES[6]!.ref, SOURCES[8]!.ref] },
  ],
  layout: { type: "split", dir: "row", sizes: [0.5, 0.5], children: [{ type: "leaf", windowId: "w-build" }, { type: "leaf", windowId: "w-news" }] },
};

/** Sample access, standing in for Check against the dest ACL. */
function access(ref: SourceRef): AccessState {
  if (ref.network === "atproto" || ref.network === "farcaster") return { kind: "read-only-unlinked" };
  if (!ref.network.startsWith("s3rch:")) return { kind: "read-only" };
  if (ref.network !== NET) return { kind: "needs-connection" };
  if (ref.kind === "forum") return ref.owner === ME ? { kind: "read", post: true } : { kind: "on-open" };
  if (ref.source === "finance") return { kind: "locked", reason: "missing-grant" };
  return { kind: "read", post: ref.owner === ME };
}

const FIN = SOURCES.find((x) => x.ref.source === "finance")!.ref;
const STATUS_WINDOWS = [
  { title: "Added as pending", declined: false, window: { id: "p", kind: "chat" as const, mode: "single" as const, sources: [FIN], pending: [formatCanonical(FIN)] } },
  { title: "Request declined", declined: true, window: { id: "d", kind: "chat" as const, mode: "single" as const, sources: [FIN], pending: [formatCanonical(FIN)] } },
  { title: "Grant revoked", declined: false, window: { id: "r", kind: "chat" as const, mode: "single" as const, sources: [FIN] } },
];

let n = 0;

export function PickerPreview({ step, tab, states }: { step: 1 | 2; tab: PickerTab; states?: boolean }) {
  const [open, setOpen] = useState(true);
  const [view, setView] = useState(VIEW);
  return (
    <main className="min-h-screen p-8">
      <p className="text-sm text-ink-muted">View: {view.title} · {view.windows.length} windows</p>
      {states ? (
        <div className="mt-6 grid max-w-4xl grid-cols-3 gap-4">
          {STATUS_WINDOWS.map((w) => (
            <section key={w.window.id} className="border border-rule bg-panel p-4">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">{w.title}</h3>
              <ViewsWindowStatus window={w.window} access={access} declined={() => w.declined} label={() => "# finance"} />
            </section>
          ))}
        </div>
      ) : null}
      {open && !states ? (
        <ViewsPicker
          view={view}
          sources={SOURCES}
          recents={[{ ref: SOURCES[0]!.ref, at: 3 }, { ref: SOURCES[6]!.ref, at: 2 }, { ref: SOURCES[7]!.ref, at: 1 }]}
          favorites={[SOURCES[3]!.ref, SOURCES[8]!.ref]}
          selfNetwork={NET}
          me={ME}
          initialTab={tab}
          startOnSources={step === 2}
          newId={() => `w${++n}`}
          access={access}
          onConfirm={(v) => { setView(v); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      ) : (
        <button type="button" className="mt-4 underline" onClick={() => setOpen(true)}>Open picker</button>
      )}
    </main>
  );
}
