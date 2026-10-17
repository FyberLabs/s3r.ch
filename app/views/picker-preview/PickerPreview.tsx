"use client";

import { useState } from "react";
import { ViewsPicker } from "@/components/ViewsPicker";
import { ViewsWindow } from "@/components/ViewsWindow";
import { ViewsWindowStatus } from "@/components/ViewsWindowStatus";
import type { ObservedRow } from "@/lib/views-decorators";
import type { ViewWindow } from "@/lib/views-window";
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

/** A sample source by its source id. */
const by = (source: string) => SOURCES.find((x) => x.ref.source === source)!.ref;

const VIEW: View = {
  id: "dev",
  title: "Dev + streams",
  v: 1,
  windows: [
    { id: "w-build", kind: "chat", mode: "single", label: "build-chat", sources: [by("build")] },
    { id: "w-news", kind: "feed", mode: "merged", label: "News", sources: [by("dev"), by("https://hn.example/rss")] },
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

const FIN = by("finance");
const STATUS_WINDOWS = [
  { title: "Added as pending", declined: false, window: { id: "p", kind: "chat" as const, mode: "single" as const, sources: [FIN], pending: [formatCanonical(FIN)] } },
  { title: "Request declined", declined: true, window: { id: "d", kind: "chat" as const, mode: "single" as const, sources: [FIN], pending: [formatCanonical(FIN)] } },
  { title: "Grant revoked", declined: false, window: { id: "r", kind: "chat" as const, mode: "single" as const, sources: [FIN] } },
];

const labelOf = (ref: SourceRef) => SOURCES.find((x) => formatCanonical(x.ref) === formatCanonical(ref))?.label ?? ref.source;

function sample(source: SourceRef, items: [string, string, number][], observedAt = 1_800_000_000): ObservedRow[] {
  return items.map(([author, body, ts], i) => ({ row: { key: `${formatCanonical(source)}#${i}`, source, id: String(i), author, body, ts }, observedAt }));
}

const T = 1_800_000_000;
const WINDOWS: { window: ViewWindow; rows: ObservedRow[] }[] = [
  {
    window: { id: "s1", kind: "chat", mode: "single", sources: [by("build")] },
    rows: sample(by("build"), [["0x9c…", "deploy green on main", T - 120], ["0x41…", "ship it", T - 60]]),
  },
  {
    window: { id: "s2", kind: "chat", mode: "single", sources: [by("ops")] },
    rows: sample(by("ops"), [["0x70…", "rotating the seed peer at 22:00", T - 300]]),
  },
  {
    window: { id: "m", kind: "feed", mode: "merged", label: "News", sources: [by("dev"), by("posts"), by("https://hn.example/rss")] },
    rows: [
      ...sample(by("dev"), [["dwr", "new frames release", T - 30]]),
      ...sample(by("posts"), [["alice", "notes from the meetup", T - 90]]),
      // A future timestamp is clamped to the observed time.
      ...sample(by("https://hn.example/rss"), [["hn", "Show HN: a P2P chat", T + 86_400]], T - 200),
    ],
  },
  {
    window: { id: "t", kind: "chat", mode: "tabs", label: "Team chats", sources: [by("build"), by("design"), by("ops")] },
    rows: [
      ...sample(by("build"), [["0x9c…", "CI is green", T - 10]]),
      ...sample(by("design"), [["0xA1…", "new picker shots are up", T - 20]]),
    ],
  },
];

function WindowsPreview() {
  const [last, setLast] = useState<SourceRef | undefined>();
  const [sent, setSent] = useState<string | null>(null);
  return (
    <>
      <div className="mt-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
        {WINDOWS.map(({ window, rows }) => (
          <ViewsWindow key={window.id} window={window} rows={rows} label={labelOf} access={access} lastTarget={last} onSend={(t, text) => { setLast(t); setSent(`Sent to ${labelOf(t)}: ${text}`); }} />
        ))}
      </div>
      {sent ? <p role="status" className="mt-4 text-sm text-ink-muted">{sent}</p> : null}
    </>
  );
}

let n = 0;

export function WindowsPage() {
  return (
    <main className="min-h-screen p-8">
      <p className="text-sm text-ink-muted">View: Dev + streams · split windows, a merged feed and a tabbed window</p>
      <WindowsPreview />
    </main>
  );
}

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
          recents={[{ ref: by("build"), at: 3 }, { ref: by("dev"), at: 2 }, { ref: by("posts"), at: 1 }]}
          favorites={[by("ops"), by("https://hn.example/rss")]}
          selfNetwork={NET}
          me={ME}
          initialTab={tab}
          startOnSources={step === 2}
          newId={() => `w${++n}`}
          access={access}
          onConfirm={(v) => { setView(v); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      ) : states ? null : (
        <button type="button" className="mt-4 underline" onClick={() => setOpen(true)}>Open picker</button>
      )}
    </main>
  );
}
