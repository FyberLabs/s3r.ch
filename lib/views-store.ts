/**
 * Local Views state: saved Views with version vectors, tombstones and conflicting copies,
 * plus recents and favorites. Persisted in origin-scoped IndexedDB, one record per wallet.
 * See docs/views.md §2 and §5.
 */
import { getAddress } from "viem";
import { formatCanonical, sameSource, validateSourceRef, type SourceRef } from "./views-source-ref";
import { canonicalJson } from "./views-canonical";
import { bumpVV, compareVV, isSafeKey, isVersionVector, maxVV, type VersionVector } from "./views-vv";
import { loadView, type Notice, type View } from "./views-window";

export const RECENTS_MAX = 20;
export const FAVORITES_MAX = 200;
/** Live Views (any non-deleted version). */
export const VIEWS_MAX = 100;
/** Entries whose every version is a tombstone. Kept so stale copies cannot bring a View back. */
export const TOMBSTONES_MAX = 1000;
export const ENTRIES_MAX = VIEWS_MAX + TOMBSTONES_MAX;
/** Unresolved concurrent copies kept per View (in addition to the current one). */
export const CONFLICTS_MAX = 3;

/** One version of a View. A tombstone has `deleted: true` and no `view`. */
export type ViewVersion =
  | { id: string; vv: VersionVector; deleted?: undefined; view: View }
  | { id: string; vv: VersionVector; deleted: true; view?: undefined };

/** Current version plus any concurrent versions the user has not resolved. */
export type ViewEntry = { current: ViewVersion; conflicts: ViewVersion[] };

export type RecentEntry = { ref: SourceRef; at: number };

export type ViewsState = {
  owner: string;
  deviceId: string;
  views: Record<string, ViewEntry>;
  recents: RecentEntry[];
  favorites: SourceRef[];
  v: 1;
};

export function emptyState(owner: string, deviceId: string): ViewsState {
  if (!isSafeKey(deviceId)) throw new Error("deviceId is empty or reserved");
  return { owner: getAddress(owner), deviceId, views: {}, recents: [], favorites: [], v: 1 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const noId = () => {
  throw new Error("stored views must already have unique window ids");
};

/** Validate one stored version. Window-level problems are reported as notices. */
export function parseVersion(input: unknown, notices: Notice[]): ViewVersion | null {
  if (!isRecord(input) || typeof input.id !== "string" || !isSafeKey(input.id) || !isVersionVector(input.vv)) return null;
  if (input.deleted === true) return input.view === undefined ? { id: input.id, vv: { ...input.vv }, deleted: true } : null;
  if (input.deleted !== undefined) return null;
  let loaded;
  try {
    loaded = loadView(input.view, noId);
  } catch {
    return null;
  }
  if (!loaded.ok || loaded.view.id !== input.id) return null;
  notices.push(...loaded.notices);
  return { id: input.id, vv: { ...input.vv }, view: loaded.view };
}

/** Validate a stored state. Invalid entries are dropped with a notice. */
export function parseState(input: unknown, owner: string, deviceId: string): { state: ViewsState; notices: Notice[] } {
  const notices: Notice[] = [];
  const state = emptyState(owner, deviceId);
  if (!isRecord(input) || input.v !== 1 || input.owner !== state.owner) return { state, notices };
  if (isRecord(input.views)) {
    for (const [id, raw] of Object.entries(input.views).slice(0, ENTRIES_MAX)) {
      if (!isRecord(raw) || !isSafeKey(id)) continue;
      const current = parseVersion(raw.current, notices);
      if (!current || current.id !== id) {
        notices.push({ message: `Saved view ${id} could not be read and was skipped` });
        continue;
      }
      const conflicts = (Array.isArray(raw.conflicts) ? raw.conflicts : [])
        .map((c) => parseVersion(c, notices))
        .filter((c): c is ViewVersion => c !== null && c.id === id)
        .slice(0, CONFLICTS_MAX);
      state.views[id] = { current, conflicts };
    }
  }
  if (Array.isArray(input.recents)) {
    for (const r of input.recents) {
      if (!isRecord(r) || typeof r.at !== "number" || !Number.isFinite(r.at)) continue;
      const ref = validateSourceRef(r.ref);
      if (ref.ok && !state.recents.some((x) => sameSource(x.ref, ref.value))) state.recents.push({ ref: ref.value, at: r.at });
    }
    state.recents = state.recents.slice(0, RECENTS_MAX);
  }
  if (Array.isArray(input.favorites)) {
    for (const f of input.favorites) {
      const ref = validateSourceRef(f);
      if (ref.ok && !state.favorites.some((x) => sameSource(x, ref.value))) state.favorites.push(ref.value);
    }
    state.favorites = state.favorites.slice(0, FAVORITES_MAX);
  }
  return { state, notices };
}

/** Save a local edit: validates the View and bumps this device's vector component. */
export function saveView(state: ViewsState, view: View): { state: ViewsState; notices: Notice[] } {
  if (!isSafeKey(view.id)) throw new Error("view id is empty or reserved");
  const loaded = loadView(view, noId);
  if (!loaded.ok) throw new Error(loaded.error);
  const prior = entryOf(state, view.id);
  // Editing while copies conflict would claim ancestry from copies the user has not chosen.
  if (prior && prior.conflicts.length) throw new Error("resolve conflicting copies first");
  const base = prior ? prior.current.vv : {};
  // A new id, or a tombstoned one being brought back, takes a live slot.
  if (!prior || !isLiveEntry(prior)) {
    const { live } = countEntries(state);
    if (live >= VIEWS_MAX) throw new Error(`at most ${VIEWS_MAX} views`);
    if (!prior && Object.keys(state.views).length >= ENTRIES_MAX) throw new Error("too many deleted views are retained");
  }
  const current: ViewVersion = { id: view.id, vv: bumpVV(base, state.deviceId), view: loaded.view };
  return { state: { ...state, views: { ...state.views, [view.id]: { current, conflicts: [] } } }, notices: loaded.notices };
}

/** Delete locally: writes a tombstone that dominates every known version. */
export function isLiveEntry(entry: ViewEntry): boolean {
  return [entry.current, ...entry.conflicts].some((v) => !v.deleted);
}

/** Live entries count against VIEWS_MAX; tombstone-only entries against TOMBSTONES_MAX. */
export function countEntries(state: ViewsState): { live: number; tombstones: number } {
  let live = 0;
  let tombstones = 0;
  for (const e of Object.values(state.views)) {
    if (isLiveEntry(e)) live += 1;
    else tombstones += 1;
  }
  return { live, tombstones };
}

function entryOf(state: ViewsState, id: string): ViewEntry | undefined {
  return Object.hasOwn(state.views, id) ? state.views[id] : undefined;
}

export function deleteView(state: ViewsState, id: string): ViewsState {
  const prior = entryOf(state, id);
  if (!prior) return state;
  if (isLiveEntry(prior) && countEntries(state).tombstones >= TOMBSTONES_MAX) {
    throw new Error("too many deleted views are retained");
  }
  const vv = bumpVV(maxVV(prior.current.vv, ...prior.conflicts.map((c) => c.vv)), state.deviceId);
  return { ...state, views: { ...state.views, [id]: { current: { id, vv, deleted: true }, conflicts: [] } } };
}

/** Resolve conflicting copies by picking one; the result dominates every branch it replaces. */
export function resolveConflict(state: ViewsState, id: string, chosen: ViewVersion): ViewsState {
  const entry = entryOf(state, id);
  if (!entry) return state;
  const all = [entry.current, ...entry.conflicts];
  const chosenText = canonicalJson(chosen);
  if (chosen.id !== id || (chosen.view && chosen.view.id !== id) || !all.some((v) => canonicalJson(v) === chosenText)) {
    throw new Error("chosen version is not one of this view's copies");
  }
  const vv = bumpVV(maxVV(...all.map((v) => v.vv)), state.deviceId);
  const current: ViewVersion = chosen.deleted ? { id, vv, deleted: true } : { id, vv, view: chosen.view };
  return { ...state, views: { ...state.views, [id]: { current, conflicts: [] } } };
}

/**
 * Merge an incoming version (from a backup or another device) into an entry. A version
 * dominated by a known one is ignored; one that dominates replaces those it dominates;
 * concurrent versions are kept as conflicting copies.
 */
export function mergeVersion(entry: ViewEntry | undefined, incoming: ViewVersion): ViewEntry {
  return mergeVersionChecked(entry, incoming).entry;
}

/**
 * Same as mergeVersion, but reports `overflow` instead of merging when keeping the incoming
 * version would exceed CONFLICTS_MAX conflicting copies; the caller tells the user.
 */
export function mergeVersionChecked(entry: ViewEntry | undefined, incoming: ViewVersion): { entry: ViewEntry; overflow: boolean } {
  const merged = mergeInner(entry, incoming);
  if (merged.conflicts.length > CONFLICTS_MAX) return { entry: entry!, overflow: true };
  return { entry: merged, overflow: false };
}

function mergeInner(entry: ViewEntry | undefined, incoming: ViewVersion): ViewEntry {
  if (!entry) return { current: incoming, conflicts: [] };
  const known = [entry.current, ...entry.conflicts];
  if (known.some((k) => {
    const o = compareVV(incoming.vv, k.vv);
    return o === "before" || o === "equal";
  })) {
    return entry;
  }
  const survivors = known.filter((k) => compareVV(incoming.vv, k.vv) !== "after");
  const [current, ...conflicts] = [incoming, ...survivors];
  return { current: current!, conflicts };
}

/** Views the user can open: current non-deleted versions, plus a flag when copies conflict. */
export function listViews(state: ViewsState): { view: View; conflicted: boolean }[] {
  const out: { view: View; conflicted: boolean }[] = [];
  for (const entry of Object.values(state.views)) {
    const live = [entry.current, ...entry.conflicts].find((v) => !v.deleted);
    if (live?.view) out.push({ view: live.view, conflicted: entry.conflicts.length > 0 });
  }
  return out.sort((a, b) => a.view.title.localeCompare(b.view.title) || a.view.id.localeCompare(b.view.id));
}

/**
 * Merge recents and favorites from a backup. Recents are combined by most recent `at`,
 * unique and capped; favorites are the union, capped. Input is validated like stored state.
 */
export function mergePrefs(state: ViewsState, incoming: unknown[]): ViewsState {
  // All inputs are aggregated and ordered before capping, so the result does not depend on
  // the order of the backups.
  const parsed = incoming.map(
    (one) => parseState({ ...(isRecord(one) ? one : {}), owner: state.owner, v: 1, views: {} }, state.owner, state.deviceId).state,
  );
  const key = (r: SourceRef) => formatCanonical(r);
  const recents: RecentEntry[] = [];
  const allRecents = [...state.recents, ...parsed.flatMap((p) => p.recents)].sort(
    (a, b) => b.at - a.at || (key(a.ref) < key(b.ref) ? -1 : key(a.ref) > key(b.ref) ? 1 : 0),
  );
  for (const r of allRecents) if (!recents.some((x) => sameSource(x.ref, r.ref))) recents.push(r);
  // Local favorites first, then incoming ones in canonical order.
  const favorites = [...state.favorites];
  const incomingFavs = parsed.flatMap((p) => p.favorites).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  for (const f of incomingFavs) if (!favorites.some((x) => sameSource(x, f))) favorites.push(f);
  return { ...state, recents: recents.slice(0, RECENTS_MAX), favorites: favorites.slice(0, FAVORITES_MAX) };
}

/** Record that a source was opened or added. Most recent first, unique, capped. */
export function touchRecent(state: ViewsState, ref: SourceRef, at: number): ViewsState {
  const checked = validateSourceRef(ref);
  if (!checked.ok) throw new Error(checked.error);
  if (!Number.isFinite(at)) throw new Error("invalid time");
  const prior = state.recents.find((r) => sameSource(r.ref, ref));
  const entry = { ref: checked.value, at: prior ? Math.max(prior.at, at) : at };
  const recents = [entry, ...state.recents.filter((r) => !sameSource(r.ref, ref))]
    .sort((x, y) => y.at - x.at)
    .slice(0, RECENTS_MAX);
  return { ...state, recents };
}

export function isFavorite(state: ViewsState, ref: SourceRef): boolean {
  return state.favorites.some((f) => sameSource(f, ref));
}

export function toggleFavorite(state: ViewsState, ref: SourceRef): ViewsState {
  const checked = validateSourceRef(ref);
  if (!checked.ok) throw new Error(checked.error);
  if (isFavorite(state, ref)) return { ...state, favorites: state.favorites.filter((f) => !sameSource(f, ref)) };
  if (state.favorites.length >= FAVORITES_MAX) throw new Error(`at most ${FAVORITES_MAX} favorites`);
  return { ...state, favorites: [...state.favorites, checked.value] };
}

/* ---------- persistence ---------- */

export type ViewsStore = {
  /**
   * Read the state, apply `fn`, and write the result, as one serialized step across tabs.
   * Returns the new state.
   */
  update(owner: string, deviceId: string, fn: (state: ViewsState) => ViewsState): Promise<ViewsState>;
  read(owner: string, deviceId: string): Promise<{ state: ViewsState; notices: Notice[] }>;
};

type Lock = <T>(name: string, run: () => Promise<T>) => Promise<T>;

/** Web Locks when available, otherwise an in-process queue (single tab or tests). */
export function defaultLock(): Lock {
  const locks = (globalThis.navigator as { locks?: { request: (n: string, cb: () => Promise<unknown>) => Promise<unknown> } } | undefined)?.locks;
  if (locks) return (name, run) => locks.request(name, run) as Promise<never>;
  const tails = new Map<string, Promise<unknown>>();
  return (name, run) => {
    const prev = tails.get(name) ?? Promise.resolve();
    const next = prev.then(run, run);
    tails.set(name, next.catch(() => undefined));
    return next;
  };
}

type RawIO = { get(owner: string): Promise<unknown>; put(owner: string, value: ViewsState): Promise<void> };

function makeStore(io: RawIO, lock: Lock): ViewsStore {
  return {
    async read(owner, deviceId) {
      const key = getAddress(owner);
      return parseState(await io.get(key), key, deviceId);
    },
    async update(owner, deviceId, fn) {
      const key = getAddress(owner);
      return lock(`s3rch-views:${key}`, async () => {
        const { state } = parseState(await io.get(key), key, deviceId);
        const next = fn(state);
        if (next.owner !== key) throw new Error("owner changed");
        await io.put(key, next);
        return next;
      });
    },
  };
}

export function createMemoryViewsStore(lock: Lock = defaultLock()): ViewsStore {
  const map = new Map<string, unknown>();
  return makeStore(
    {
      async get(owner) {
        const raw = map.get(owner);
        return raw === undefined ? undefined : structuredClone(raw);
      },
      async put(owner, value) {
        map.set(owner, structuredClone(value));
      },
    },
    lock,
  );
}

export const VIEWS_IDB_NAME = "s3rch-views";
export const VIEWS_IDB_VERSION = 1;
export const VIEWS_STORE_NAME = "views-state";

function openViewsDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(VIEWS_IDB_NAME, VIEWS_IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(VIEWS_STORE_NAME)) db.createObjectStore(VIEWS_STORE_NAME, { keyPath: "owner" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed."));
  });
}

function idb<T>(factory: IDBFactory | undefined, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  if (!factory) return Promise.reject(new Error("IndexedDB is not available in this runtime."));
  return openViewsDb(factory).then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(VIEWS_STORE_NAME, mode);
        const request = run(tx.objectStore(VIEWS_STORE_NAME));
        let result: T;
        request.onsuccess = () => {
          result = request.result;
        };
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
        // Resolve only after the transaction commits, so a write is durable before success is reported.
        tx.oncomplete = () => {
          db.close();
          resolve(result);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error("IndexedDB transaction aborted."));
        };
      }),
  );
}

export function createIndexedDbViewsStore(factory: IDBFactory | undefined = globalThis.indexedDB, lock: Lock = defaultLock()): ViewsStore {
  return makeStore(
    {
      get: (owner) => idb(factory, "readonly", (s) => s.get(owner)),
      put: async (owner, value) => {
        await idb(factory, "readwrite", (s) => s.put({ ...value, owner }));
      },
    },
    lock,
  );
}
