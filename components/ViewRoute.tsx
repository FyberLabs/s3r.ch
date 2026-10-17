"use client";

/**
 * The `/views/[id]` route (docs/views.md §6, PR 6): loads the signed-in user's View from the
 * local store and shows it in its saved layout. Resizes are saved, and the picker adds
 * windows (recording the added sources in Recents). A View with conflicting copies shows the
 * copies and opens once one is chosen.
 *
 * Rows, access states and the picker's sources come from `data`. Until sources are connected
 * to live data, the route shows each window's slot with no rows.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { btnPrimary, btnSecondary } from "@/lib/brand-ui";
import type { AccessState } from "@/lib/views-access";
import type { ObservedRow } from "@/lib/views-decorators";
import { addedSources, markSeen, openView, parseSeen, seenStorageKey, settleView, type SeenTimes } from "@/lib/views-layout";
import { labelFor, type PickerSource } from "@/lib/views-picker";
import type { SourceRef } from "@/lib/views-source-ref";
import { createIndexedDbViewsStore, resolveConflict, saveView, touchRecent, type ViewsState, type ViewsStore, type ViewVersion } from "@/lib/views-store";
import type { LayoutTree, Notice, View } from "@/lib/views-window";
import { ViewsPicker } from "./ViewsPicker";
import { ViewsScreen } from "./ViewsScreen";
import { objectOwner, useIdentitySession } from "./useIdentitySession";

export type ViewData = {
  rows: ObservedRow[];
  access: (ref: SourceRef) => AccessState;
  /** Sources the picker can browse, and this deployment's network. */
  sources: PickerSource[];
  selfNetwork: string;
};

/** No live data yet: no rows, nothing to browse, and every source is checked when opened. */
const NO_DATA: ViewData = { rows: [], access: () => ({ kind: "on-open" }), sources: [], selfNetwork: "" };

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

export function ViewRoute({ id, data = NO_DATA }: { id: string; data?: ViewData }) {
  const session = useIdentitySession();
  const owner = session ? objectOwner(session) : null;
  const store = useMemo(() => (typeof indexedDB === "undefined" ? null : createIndexedDbViewsStore()), []);
  if (!owner) return <Shell>Sign in to open your Views. They are saved on this device for your account.</Shell>;
  if (!store) return <Shell>This browser can&apos;t store Views.</Shell>;
  // A new owner or id starts from scratch, so nothing from the previous View stays on screen.
  return <OwnedView key={`${owner}\n${id}`} id={id} owner={owner} store={store} data={data} />;
}

type Loaded = { state: ViewsState; view: View; conflicted: boolean; notices: Notice[] } | { missing: true } | null;

function OwnedView({ id, owner, store, data }: { id: string; owner: string; store: ViewsStore; data: ViewData }) {
  const [loaded, setLoaded] = useState<Loaded>(null);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<SeenTimes | null>(null);
  const [picking, setPicking] = useState(false);

  const show = useCallback(
    (state: ViewsState, notices: Notice[]) => {
      const found = openView(state, id);
      setLoaded(found ? { state, ...found, notices } : { missing: true });
    },
    [id],
  );

  useEffect(() => {
    let live = true;
    store
      .read(owner, deviceId())
      .then(({ state, notices }) => live && show(state, notices))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [owner, store, show]);

  const onSeen = useCallback(
    (next: SeenTimes) => {
      setSeen(next);
      localStorage.setItem(seenStorageKey(owner, id), JSON.stringify(next));
    },
    [owner, id],
  );

  const view = loaded && !("missing" in loaded) ? loaded.view : null;
  const windowIds = view ? view.windows.map((w) => w.id).join("\n") : null;

  // Windows never seen on this device start counting from now; the baseline is stored at once.
  useEffect(() => {
    if (windowIds === null) return;
    const ids = windowIds ? windowIds.split("\n") : [];
    const current = seen ?? parseSeen(localStorage.getItem(seenStorageKey(owner, id)), ids);
    const missing = ids.filter((w) => !Object.hasOwn(current, w));
    if (missing.length || seen === null) onSeen(markSeen(current, missing, nowSeconds()));
  }, [windowIds, seen, owner, id, onSeen]);

  const commit = useCallback(
    async (fn: (state: ViewsState) => ViewsState) => {
      try {
        const { state } = await store.update(owner, deviceId(), fn);
        show(state, []);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [owner, store, show],
  );

  /** Save an edit of the stored View. With `base`, refuse if the View changed since then. */
  const save = useCallback(
    (edit: (view: View) => View, base?: View, then?: (state: ViewsState, before: View, after: View) => ViewsState) =>
      commit((s) => {
        const found = openView(s, id);
        if (!found) throw new Error("This View was deleted");
        // A whole-View edit made from an older copy would drop changes saved since.
        if (base && JSON.stringify(found.view) !== JSON.stringify(base)) throw new Error("This View changed in another tab. Reload and try again.");
        const after = edit(found.view);
        const next = saveView(s, after).state;
        return then ? then(next, found.view, after) : next;
      }),
    [commit, id],
  );

  // Sources that became readable drop their pending marks (docs/views.md §3.7).
  const conflicted = !!loaded && !("missing" in loaded) && loaded.conflicted;
  useEffect(() => {
    if (!view || conflicted || !settleView(view, data.access)) return;
    void save((v) => settleView(v, data.access) ?? v);
  }, [view, conflicted, data.access, save]);

  if (error && !loaded) return <Shell>Couldn&apos;t open this View: {error}</Shell>;
  if (!loaded) return <Shell>Loading…</Shell>;
  if ("missing" in loaded) return <Shell>There is no View with this id on this device.</Shell>;

  const { state } = loaded;
  const label = (ref: SourceRef) => labelFor(ref, data.sources);
  return (
    <section className="flex min-h-[80vh] flex-col gap-3 px-4 py-4">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{loaded.view.title}</h1>
        {!conflicted ? (
          <button type="button" className={`${btnSecondary} ml-auto`} onClick={() => setPicking(true)}>
            + Add
          </button>
        ) : null}
      </header>
      {loaded.notices.length ? (
        <ul role="status" className="space-y-1 text-sm text-ink-muted">
          {loaded.notices.map((n, i) => (
            <li key={i}>{n.message}</li>
          ))}
        </ul>
      ) : null}
      {error ? <p role="alert" className="text-sm text-status-fail">{error}</p> : null}
      {conflicted ? (
        <Conflicts copies={copiesOf(state, id)} onChoose={(chosen) => void commit((s) => resolveConflict(s, id, chosen))} />
      ) : (
        <ViewsScreen
          view={loaded.view}
          rows={data.rows}
          access={data.access}
          label={label}
          seen={seen ?? {}}
          onSeen={onSeen}
          now={nowSeconds}
          onLayout={(layout: LayoutTree) => void save((v) => ({ ...v, layout }))}
          onAdd={() => setPicking(true)}
        />
      )}
      {picking && !conflicted ? (
        <ViewsPicker
          view={loaded.view}
          sources={data.sources}
          recents={state.recents}
          favorites={state.favorites}
          selfNetwork={data.selfNetwork}
          me={owner}
          access={data.access}
          newId={() => crypto.randomUUID()}
          target={{ type: "new" }}
          onConfirm={(next) => {
            setPicking(false);
            const at = Date.now();
            void save(
              () => next,
              loaded.view,
              (s, before, after) => addedSources(before, after).reduce((acc, ref) => touchRecent(acc, ref, at), s),
            );
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </section>
  );
}

/** Live copies of a conflicted View, current first. */
function copiesOf(state: ViewsState, id: string): ViewVersion[] {
  const entry = state.views[id];
  return entry ? [entry.current, ...entry.conflicts].filter((v) => v.view) : [];
}

function Conflicts({ copies, onChoose }: { copies: ViewVersion[]; onChoose: (chosen: ViewVersion) => void }) {
  return (
    <div role="region" aria-label="Conflicting copies" className="space-y-3 border border-rule p-4">
      <p className="text-sm">This View was changed on more than one device. Choose the copy to keep; the others are replaced.</p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {copies.map((c, i) => (
          <li key={i} className="space-y-2 border border-rule p-3 text-sm">
            <p className="font-semibold">{c.view!.title}</p>
            <ul className="text-ink-muted">
              {c.view!.windows.map((w) => (
                <li key={w.id}>
                  {w.label ?? w.kind} · {w.sources.length} {w.sources.length === 1 ? "source" : "sources"}
                </li>
              ))}
              {c.view!.windows.length === 0 ? <li>No windows</li> : null}
            </ul>
            <button type="button" className={btnPrimary} onClick={() => onChoose(c)}>
              Keep this copy
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <section className="mx-auto max-w-3xl px-4 py-12 text-ink-muted">{children}</section>;
}
