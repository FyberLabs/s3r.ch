"use client";

/**
 * The `/views/[id]` route (docs/views.md §6, PR 6): loads the signed-in user's View from the
 * local store and shows it in its saved layout. Resizes are saved, and the picker adds
 * windows (recording the added sources in Recents). A View with conflicting copies shows the
 * copies and opens once one is chosen.
 *
 * Rows, access states and the picker's sources come from `data`. The route fills that from
 * the signed-in owner's rooms, forum channels and followed feeds. Pass `data` only to supply
 * a fixed snapshot.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { btnPrimary, btnSecondary } from "@/lib/brand-ui";
import type { AccessState } from "@/lib/views-access";
import type { ObservedRow } from "@/lib/views-decorators";
import { addedSources, createLayoutSaveQueue, drainLayoutSaves, editView, markSeen, mergeSeen, openView, parseSeen, seenBaseline, seenNow, seenStorageKey, settleView, type SeenTimes } from "@/lib/views-layout";
import { labelFor, type PickerSource } from "@/lib/views-picker";
import type { SourceRef } from "@/lib/views-source-ref";
import { createIndexedDbViewsStore, resolveConflict, touchRecent, type ViewsState, type ViewsStore, type ViewVersion } from "@/lib/views-store";
import type { LayoutTree, Notice, View } from "@/lib/views-window";
import { GunPeerProvider } from "./GunPeerProvider";
import { MeshAclSync } from "./MeshAclSync";
import { SeeAclProvider } from "./SeeAclProvider";
import { useViewLiveData } from "./useViewLiveData";
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

const DEVICE_KEY = "s3rch-views-device";

/** Throws when the browser blocks local storage; callers report it as an open or save error. */
function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

/** Last-seen times are a convenience: blocked storage means they are kept for this visit only. */
function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Kept in memory only.
  }
}

export function ViewRoute({ id, data }: { id: string; data?: ViewData }) {
  return (
    <SeeAclProvider>
      <GunPeerProvider>
        <MeshAclSync />
        <ViewRouteBody id={id} data={data} />
      </GunPeerProvider>
    </SeeAclProvider>
  );
}

function ViewRouteBody({ id, data }: { id: string; data?: ViewData }) {
  const session = useIdentitySession();
  const owner = session ? objectOwner(session) : null;
  const store = useMemo(() => (typeof indexedDB === "undefined" ? null : createIndexedDbViewsStore()), []);
  if (!owner) return <Shell>Sign in to open your Views. They are saved on this device for your account.</Shell>;
  if (!store) return <Shell>This browser can&apos;t store Views.</Shell>;
  // A new owner or id starts from scratch, so nothing from the previous View stays on screen.
  return <OwnedView key={`${owner}\n${id}`} id={id} owner={owner} store={store} data={data} />;
}

type Loaded = { state: ViewsState; view: View; conflicted: boolean; notices: Notice[] } | { missing: true } | null;

function OwnedView({ id, owner, store, data }: { id: string; owner: string; store: ViewsStore; data?: ViewData }) {
  const [loaded, setLoaded] = useState<Loaded>(null);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<SeenTimes | null>(null);
  const [picking, setPicking] = useState(false);
  /**
   * The stored View as this tab last read or wrote it. Checked edits are refused when the
   * store holds something else (another tab saved since). Writes update it inside the store
   * update, so this tab's own queued edits never refuse each other.
   */
  const known = useRef<View | null>(null);

  const show = useCallback(
    (state: ViewsState, notices: Notice[]) => {
      const found = openView(state, id);
      setLoaded(found ? { state, ...found, notices } : { missing: true });
    },
    [id],
  );

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => store.read(owner, deviceId()))
      .then(({ state, notices }) => {
        if (!live) return;
        known.current = openView(state, id)?.view ?? null;
        show(state, notices);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [owner, store, show, id]);

  const view = loaded && !("missing" in loaded) ? loaded.view : null;
  const live = useViewLiveData(view, owner, data === undefined);
  const shown = data ?? live;
  // Serialized so effects rerun only when the ids change; JSON keeps any id intact.
  const windowIds = view ? JSON.stringify(view.windows.map((w) => w.id)) : null;
  const key = seenStorageKey(owner, id);

  // Another tab's times are merged in, keeping the later time per window, so neither tab
  // moves a window's time back.
  const onSeen = useCallback(
    (next: SeenTimes) => {
      const ids: string[] = windowIds ? JSON.parse(windowIds) : [];
      const merged = mergeSeen(parseSeen(readLocal(key), ids), next);
      setSeen(merged);
      writeLocal(key, JSON.stringify(merged));
    },
    [key, windowIds],
  );

  useEffect(() => {
    if (windowIds === null) return;
    const ids: string[] = JSON.parse(windowIds);
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) setSeen((prev) => mergeSeen(prev ?? Object.create(null), parseSeen(e.newValue, ids)));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, windowIds]);

  // Windows never seen on this device start counting from now; the baseline is stored at once.
  useEffect(() => {
    if (windowIds === null) return;
    const ids: string[] = JSON.parse(windowIds);
    const current = seen ?? parseSeen(readLocal(key), ids);
    const missing = ids.filter((w) => !Object.hasOwn(current, w));
    if (missing.length || seen === null) onSeen(markSeen(current, missing, seenBaseline()));
  }, [windowIds, seen, key, onSeen]);

  const commit = useCallback(
    async (fn: (state: ViewsState) => ViewsState, options?: { publish?: boolean }): Promise<ViewsState | null> => {
      const publish = options?.publish !== false;
      try {
        // Every write (edit or conflict choice) updates the known copy inside the serialized update.
        const { state } = await store.update(owner, deviceId(), (s) => {
          const next = fn(s);
          known.current = openView(next, id)?.view ?? null;
          return next;
        });
        if (publish) show(state, []);
        setError(null);
        return state;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        // Show the stored View again, so a refused edit made from an older copy is undone on screen.
        Promise.resolve()
          .then(() => store.read(owner, deviceId()))
          .then(({ state }) => {
            known.current = openView(state, id)?.view ?? null;
            show(state, []);
          })
          .catch(() => undefined);
        return null;
      }
    },
    [owner, store, show, id],
  );

  /**
   * Save an edit of the stored View. A `checked` edit (made from what is on screen) is refused
   * if another tab saved the View since this tab last read or wrote it.
   */
  const save = useCallback(
    (edit: (view: View) => View, checked: boolean, then?: (state: ViewsState, before: View, after: View) => ViewsState) =>
      commit((s) => {
        const r = editView(s, id, known.current, edit, checked);
        return then ? then(r.state, r.before, r.after) : r.state;
      }),
    [commit, id],
  );

  /**
   * Resize saves that pile up while IndexedDB is still writing. Only the newest layout is
   * written next, and a finished write is shown only when it is still that layout — an
   * earlier save must not replace a resize the user has already entered.
   */
  const layoutSaves = useRef(createLayoutSaveQueue<LayoutTree>());
  const persistLayout = useCallback(
    (layout: LayoutTree): Promise<void> => {
      const queued = layoutSaves.current.push(layout);
      if (queued.start) {
        let savedState: ViewsState | null = null;
        void drainLayoutSaves(
          layoutSaves.current,
          layout,
          async (next) => {
            const state = await commit(
              (s) => editView(s, id, known.current, (v) => ({ ...v, layout: next }), true).state,
              { publish: false },
            );
            if (!state) return null;
            savedState = state;
            return openView(state, id)?.view.layout ?? next;
          },
          () => {
            if (savedState) show(savedState, []);
          },
        );
      }
      return queued.done;
    },
    [commit, id, show],
  );

  // Sources that became readable drop their pending marks (docs/views.md §3.7).
  const conflicted = !!loaded && !("missing" in loaded) && loaded.conflicted;
  useEffect(() => {
    if (!view || conflicted || !settleView(view, shown.access)) return;
    void save((v) => settleView(v, shown.access) ?? v, false);
  }, [view, conflicted, shown.access, save]);

  if (error && !loaded) return <Shell>Couldn&apos;t open this View: {error}</Shell>;
  if (!loaded) return <Shell>Loading…</Shell>;
  if ("missing" in loaded) return <Shell>There is no View with this id on this device.</Shell>;

  const { state } = loaded;
  const label = (ref: SourceRef) => labelFor(ref, shown.sources);
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
          rows={shown.rows}
          access={shown.access}
          label={label}
          seen={seen ?? {}}
          onSeen={onSeen}
          now={seenNow}
          onLayout={persistLayout}
          onAdd={() => setPicking(true)}
        />
      )}
      {picking && !conflicted ? (
        <ViewsPicker
          view={loaded.view}
          sources={shown.sources}
          recents={state.recents}
          favorites={state.favorites}
          selfNetwork={shown.selfNetwork}
          me={owner}
          access={shown.access}
          newId={() => crypto.randomUUID()}
          target={{ type: "new" }}
          onConfirm={(next) => {
            setPicking(false);
            const at = Date.now();
            void save(
              () => next,
              true,
              (s, before, after) => addedSources(before, after).reduce((acc, ref) => touchRecent(acc, ref, at), s),
            );
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </section>
  );
}

/** Copies of a conflicted View, current first; a deletion is one of the choices. */
function copiesOf(state: ViewsState, id: string): ViewVersion[] {
  const entry = state.views[id];
  return entry ? [entry.current, ...entry.conflicts] : [];
}

function Conflicts({ copies, onChoose }: { copies: ViewVersion[]; onChoose: (chosen: ViewVersion) => void }) {
  return (
    <div role="region" aria-label="Conflicting copies" className="space-y-3 border border-rule p-4">
      <p className="text-sm">This View was changed on more than one device. Choose the copy to keep; the others are replaced.</p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {copies.map((c, i) => (
          <li key={i} className="space-y-2 border border-rule p-3 text-sm">
            {c.view ? (
              <Copy view={c.view} onKeep={() => onChoose(c)} />
            ) : (
              <>
                <p className="font-semibold">Deleted on another device</p>
                <button type="button" className={btnSecondary} onClick={() => onChoose(c)}>
                  Keep it deleted
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Copy({ view, onKeep }: { view: View; onKeep: () => void }) {
  return (
    <>
      <p className="font-semibold">{view.title}</p>
      <ul className="text-ink-muted">
        {view.windows.map((w) => (
          <li key={w.id}>
            {w.label ?? w.kind} · {w.sources.length} {w.sources.length === 1 ? "source" : "sources"}
          </li>
        ))}
        {view.windows.length === 0 ? <li>No windows</li> : null}
      </ul>
      <button type="button" className={btnPrimary} onClick={onKeep}>
        Keep this copy
      </button>
    </>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <section className="mx-auto max-w-3xl px-4 py-12 text-ink-muted">{children}</section>;
}
