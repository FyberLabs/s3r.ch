"use client";

/**
 * The `/views/[id]` route (docs/views.md §6, PR 6): loads the signed-in user's View from the
 * local store and shows it in its saved layout. Resizes are saved; a View with conflicting
 * copies opens read-only until one copy is chosen.
 *
 * Rows and access states come from `data`. Until sources are connected to live data, the
 * route shows each window's slot with no rows.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { btnSecondary } from "@/lib/brand-ui";
import type { AccessState } from "@/lib/views-access";
import type { ObservedRow } from "@/lib/views-decorators";
import { markSeen, openView, parseSeen, seenStorageKey, type SeenTimes } from "@/lib/views-layout";
import { labelFor } from "@/lib/views-picker";
import type { SourceRef } from "@/lib/views-source-ref";
import { createIndexedDbViewsStore, saveView, type ViewsState } from "@/lib/views-store";
import type { LayoutTree, Notice, View } from "@/lib/views-window";
import { ViewsPicker } from "./ViewsPicker";
import { ViewsScreen } from "./ViewsScreen";
import { objectOwner, useIdentitySession } from "./useIdentitySession";

export type ViewData = { rows: ObservedRow[]; access: (ref: SourceRef) => AccessState };

/** No live data yet: no rows, and every source is checked when opened. */
const NO_DATA: ViewData = { rows: [], access: () => ({ kind: "on-open" }) };

const DEVICE_KEY = "s3rch-views-device";

function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

type Loaded = { state: ViewsState; view: View; conflicted: boolean; notices: Notice[] } | { missing: true } | null;

export function ViewRoute({ id, data = NO_DATA }: { id: string; data?: ViewData }) {
  const session = useIdentitySession();
  const owner = session ? objectOwner(session) : null;
  const store = useMemo(() => (typeof indexedDB === "undefined" ? null : createIndexedDbViewsStore()), []);
  const [loaded, setLoaded] = useState<Loaded>(null);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<SeenTimes>({});
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!owner || !store) return;
    let live = true;
    store
      .read(owner, deviceId())
      .then(({ state, notices }) => {
        if (!live) return;
        const found = openView(state, id);
        if (!found) return setLoaded({ missing: true });
        setLoaded({ state, ...found, notices });
        const ids = found.view.windows.map((w) => w.id);
        const stored = parseSeen(localStorage.getItem(seenStorageKey(owner, id)), ids);
        // Windows never seen on this device start counting from now.
        setSeen(markSeen(stored, ids.filter((w) => !(w in stored)), nowSeconds()));
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [owner, store, id]);

  const onSeen = useCallback(
    (next: SeenTimes) => {
      setSeen(next);
      if (owner) localStorage.setItem(seenStorageKey(owner, id), JSON.stringify(next));
    },
    [owner, id],
  );

  const save = useCallback(
    async (edit: (view: View) => View, base?: View) => {
      if (!owner || !store) return;
      try {
        let saved: View | null = null;
        const { state } = await store.update(owner, deviceId(), (s) => {
          const found = openView(s, id);
          if (!found) throw new Error("This View was deleted");
          // A whole-View edit made from an older copy would drop changes saved since.
          if (base && JSON.stringify(found.view) !== JSON.stringify(base)) throw new Error("This View changed in another tab. Reload and try again.");
          saved = edit(found.view);
          return saveView(s, saved).state;
        });
        const found = openView(state, id);
        if (found) setLoaded({ state, ...found, notices: [] });
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [owner, store, id],
  );

  if (!session) return <Shell>Sign in to open your Views. They are saved on this device for your account.</Shell>;
  if (!store) return <Shell>This browser can&apos;t store Views.</Shell>;
  if (error && !loaded) return <Shell>Couldn&apos;t open this View: {error}</Shell>;
  if (!loaded) return <Shell>Loading…</Shell>;
  if ("missing" in loaded) return <Shell>There is no View with this id on this device.</Shell>;

  const { view, conflicted, state } = loaded;
  const label = (ref: SourceRef) => labelFor(ref, []);
  return (
    <section className="flex min-h-[80vh] flex-col gap-3 px-4 py-4">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{view.title}</h1>
        {!conflicted ? (
          <button type="button" className={`${btnSecondary} ml-auto`} onClick={() => setPicking(true)}>
            + Add
          </button>
        ) : null}
      </header>
      {conflicted ? <p role="status" className="border border-rule px-3 py-2 text-sm">This View has conflicting copies from different devices. It is read-only until one copy is chosen.</p> : null}
      {loaded.notices.length ? (
        <ul role="status" className="space-y-1 text-sm text-ink-muted">
          {loaded.notices.map((n, i) => (
            <li key={i}>{n.message}</li>
          ))}
        </ul>
      ) : null}
      {error ? <p role="alert" className="text-sm text-status-fail">{error}</p> : null}
      <ViewsScreen
        view={view}
        rows={data.rows}
        access={data.access}
        label={label}
        seen={seen}
        onSeen={onSeen}
        now={nowSeconds}
        onLayout={conflicted ? undefined : (layout: LayoutTree) => void save((v) => ({ ...v, layout }))}
        onAdd={conflicted ? undefined : () => setPicking(true)}
      />
      {picking ? (
        <ViewsPicker
          view={view}
          sources={[]}
          recents={state.recents}
          favorites={state.favorites}
          selfNetwork=""
          me={owner ?? undefined}
          newId={() => crypto.randomUUID()}
          target={{ type: "new" }}
          onConfirm={(next) => {
            setPicking(false);
            void save(() => next, view);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </section>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <section className="mx-auto max-w-3xl px-4 py-12 text-ink-muted">{children}</section>;
}
