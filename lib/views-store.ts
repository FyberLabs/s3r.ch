/**
 * Local Views state: saved Views with version vectors, tombstones and conflicting copies,
 * plus recents and favorites. Persisted in origin-scoped IndexedDB, one record per wallet.
 * See docs/views.md §2 and §5.
 */
import { getAddress } from "viem";
import { formatShareable, sameSource, validateSourceRef, type SourceRef } from "./views-source-ref";
import { canonicalJson } from "./views-canonical";
import {
  bumpVV,
  collapseFolded,
  compactCausal,
  compareCausal,
  coversCausal,
  expandFolded,
  isSafeKey,
  isVersionVector,
  materializeCausal,
  maxCausal,
  unionRetirements,
  type Causal,
  type VersionVector,
} from "./views-vv";
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
export type ViewVersion = Causal &
  (
    | { id: string; deleted?: undefined; view: View }
    | { id: string; deleted: true; view?: undefined }
  );

/**
 * Current version plus concurrent copies. `hidden` is the joined causal stamp of copies
 * removed by CONFLICTS_MAX, so a resolution still dominates those branches.
 */
export type ViewEntry = { current: ViewVersion; conflicts: ViewVersion[]; hidden?: Causal };

export type RecentEntry = { ref: SourceRef; at: number };

export type ViewsState = {
  owner: string;
  deviceId: string;
  views: Record<string, ViewEntry>;
  recents: RecentEntry[];
  favorites: SourceRef[];
  /** Version vector of the favorites list as a whole, so removals win over stale copies. */
  favoritesVV: VersionVector;
  /** Devices this favorites stamp compacted. See `Causal`. */
  favoritesFolded?: VersionVector;
  favoritesFoldedAll?: true;
  /** Signed per-account map of retired devices: deviceId → final counter. */
  retirements: VersionVector;
  /**
   * Joined deletion stamps for views whose tombstones were dropped by TOMBSTONES_MAX.
   * A version covered by one of these stays deleted.
   */
  dropped: Record<string, Causal>;
  v: 1;
};

export function emptyState(owner: string, deviceId: string): ViewsState {
  if (!isSafeKey(deviceId)) throw new Error("deviceId is empty or reserved");
  return { owner: getAddress(owner), deviceId, views: {}, recents: [], favorites: [], favoritesVV: {}, retirements: {}, dropped: {}, v: 1 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const noId = () => {
  throw new Error("stored views must already have unique window ids");
};

const DROPPED_MAX = 10_000;

function parseCausal(input: unknown): Causal | null {
  if (!isRecord(input) || !isVersionVector(input.vv)) return null;
  if (input.folded !== undefined && !isVersionVector(input.folded)) return null;
  if (input.foldedAll !== undefined && input.foldedAll !== true) return null;
  const out: Causal = { vv: { ...input.vv } };
  if (isVersionVector(input.folded) && Object.keys(input.folded).length) out.folded = { ...input.folded };
  if (input.foldedAll === true) out.foldedAll = true;
  return out;
}

function causalOf(v: Pick<ViewVersion, "vv" | "folded" | "foldedAll">): Causal {
  const out: Causal = { vv: v.vv };
  if (v.folded && Object.keys(v.folded).length) out.folded = v.folded;
  if (v.foldedAll) out.foldedAll = true;
  return out;
}

function withCausal(v: ViewVersion, c: Causal): ViewVersion {
  const out: ViewVersion = v.deleted ? { id: v.id, vv: c.vv, deleted: true } : { id: v.id, vv: c.vv, view: v.view };
  if (c.folded && Object.keys(c.folded).length) out.folded = c.folded;
  if (c.foldedAll) out.foldedAll = true;
  return out;
}

function presentCausal(c: Causal | undefined): Causal | undefined {
  if (!c) return undefined;
  if (Object.keys(c.vv).length === 0 && !(c.folded && Object.keys(c.folded).length) && !c.foldedAll) return undefined;
  return c;
}

function tidyEntry(entry: ViewEntry): ViewEntry {
  const hidden = presentCausal(entry.hidden);
  return hidden ? { current: entry.current, conflicts: entry.conflicts, hidden } : { current: entry.current, conflicts: entry.conflicts };
}

/** Validate one stored version. Window-level problems are reported as notices. */
export function parseVersion(input: unknown, notices: Notice[]): ViewVersion | null {
  if (!isRecord(input) || typeof input.id !== "string" || !isSafeKey(input.id) || !isVersionVector(input.vv)) return null;
  if (input.folded !== undefined && !isVersionVector(input.folded)) return null;
  if (input.foldedAll !== undefined && input.foldedAll !== true) return null;
  const causal = parseCausal({ vv: input.vv, folded: input.folded, foldedAll: input.foldedAll });
  if (!causal) return null;
  if (input.deleted === true) return input.view === undefined ? { id: input.id, ...causal, deleted: true } : null;
  if (input.deleted !== undefined) return null;
  let loaded;
  try {
    loaded = loadView(input.view, noId);
  } catch {
    return null;
  }
  if (!loaded.ok || loaded.view.id !== input.id) return null;
  notices.push(...loaded.notices);
  return { id: input.id, ...causal, view: loaded.view };
}

/** Hidden stamp carried beside a version in a backup record. Invalid stamps are dropped. */
export function parseVersionPayload(input: unknown, notices: Notice[]): { version: ViewVersion; hidden?: Causal } | null {
  const version = parseVersion(input, notices);
  if (!version || !isRecord(input) || input.hidden === undefined) return version ? { version } : null;
  const hidden = parseCausal(input.hidden);
  if (!hidden) {
    notices.push({ message: `A causal summary for view ${version.id} could not be read and was discarded` });
    return { version };
  }
  return { version, hidden: presentCausal(hidden) };
}

/** Validate a stored state. Invalid entries are dropped with a notice. */
export function parseState(input: unknown, owner: string, deviceId: string): { state: ViewsState; notices: Notice[] } {
  const notices: Notice[] = [];
  const state = emptyState(owner, deviceId);
  if (!isRecord(input) || input.v !== 1 || input.owner !== state.owner) return { state, notices };
  if (isVersionVector(input.retirements)) state.retirements = { ...input.retirements };
  if (isRecord(input.views)) {
    for (const [id, raw] of Object.entries(input.views).slice(0, ENTRIES_MAX)) {
      if (!isRecord(raw) || !isSafeKey(id)) continue;
      const current = parseVersion(raw.current, notices);
      if (!current || current.id !== id) {
        notices.push({ message: `Saved view ${id} could not be read and was skipped` });
        continue;
      }
      // Bound the input before validating each element.
      const rawConflicts = Array.isArray(raw.conflicts) ? raw.conflicts.slice(0, CONFLICTS_MAX) : [];
      const conflicts = rawConflicts
        .map((c) => parseVersion(c, notices))
        .filter((c): c is ViewVersion => c !== null && c.id === id);
      if (conflicts.length < rawConflicts.length) {
        notices.push({ message: `A conflicting copy of saved view ${id} could not be read and was discarded` });
      }
      const hidden = raw.hidden === undefined ? undefined : parseCausal(raw.hidden) ?? undefined;
      if (raw.hidden !== undefined && !hidden) {
        notices.push({ message: `A causal summary for saved view ${id} could not be read and was discarded` });
      }
      const entry = tidyEntry({ current, conflicts, hidden: hidden ? presentCausal(hidden) : undefined });
      const counts = countEntries(state);
      if (isLiveEntry(entry) ? counts.live >= VIEWS_MAX : counts.tombstones >= TOMBSTONES_MAX) {
        if (!isLiveEntry(entry) && Object.keys(state.dropped).length < DROPPED_MAX) {
          const parts = [entry.current, ...entry.conflicts, entry.hidden].map((c) => (c ? expandFolded(causalOf(c), state.retirements) : undefined));
          state.dropped[id] = maxCausal(state.dropped[id], ...parts);
        }
        notices.push({ message: `Saved view ${id} is over the limit and was skipped` });
        continue;
      }
      state.views[id] = entry;
    }
  }
  if (Array.isArray(input.recents)) {
    for (const r of input.recents.slice(0, RECENTS_MAX)) {
      if (!isRecord(r) || typeof r.at !== "number" || !Number.isFinite(r.at)) continue;
      const ref = validateSourceRef(r.ref);
      if (ref.ok && !state.recents.some((x) => sameSource(x.ref, ref.value))) state.recents.push({ ref: ref.value, at: r.at });
    }
    state.recents = state.recents.slice(0, RECENTS_MAX);
  }
  if (Array.isArray(input.favorites)) {
    for (const f of input.favorites.slice(0, FAVORITES_MAX)) {
      const ref = validateSourceRef(f);
      if (ref.ok && !state.favorites.some((x) => sameSource(x, ref.value))) state.favorites.push(ref.value);
    }
    state.favorites = state.favorites.slice(0, FAVORITES_MAX);
  }
  if (isVersionVector(input.favoritesVV)) state.favoritesVV = { ...input.favoritesVV };
  if (isVersionVector(input.favoritesFolded) && Object.keys(input.favoritesFolded).length) state.favoritesFolded = { ...input.favoritesFolded };
  if (input.favoritesFoldedAll === true) state.favoritesFoldedAll = true;
  if (isRecord(input.dropped)) {
    for (const [id, raw] of Object.entries(input.dropped)) {
      if (!isSafeKey(id) || (Object.keys(state.dropped).length >= DROPPED_MAX && !Object.hasOwn(state.dropped, id))) continue;
      const causal = parseCausal(raw);
      if (!causal) continue;
      const expanded = expandFolded(causal, state.retirements);
      const prior = Object.hasOwn(state.dropped, id) ? expandFolded(state.dropped[id]!, state.retirements) : undefined;
      state.dropped[id] = maxCausal(prior, expanded);
    }
  }
  return { state: collapseState(compactState(state, state.retirements), state.retirements), notices };
}

function favCausal(state: ViewsState): Causal {
  return expandFolded({ vv: state.favoritesVV, folded: state.favoritesFolded, foldedAll: state.favoritesFoldedAll }, state.retirements);
}

/** Expand every stamp against the retirement map it was saved with. */
export function expandState(state: ViewsState): ViewsState {
  const map = state.retirements;
  const expandVersion = (v: ViewVersion): ViewVersion => withCausal(v, expandFolded(causalOf(v), map));
  const views: ViewsState["views"] = {};
  for (const [id, entry] of Object.entries(state.views)) {
    views[id] = tidyEntry({
      current: expandVersion(entry.current),
      conflicts: entry.conflicts.map(expandVersion),
      hidden: entry.hidden ? expandFolded(entry.hidden, map) : undefined,
    });
  }
  const dropped: ViewsState["dropped"] = {};
  for (const [id, causal] of Object.entries(state.dropped)) dropped[id] = expandFolded(causal, map);
  return withFavorites({ ...state, views, dropped }, favCausal(state));
}

function compactOne(c: Causal, retirements: VersionVector): Causal {
  // `foldedAll` refers to this map. Expanding first keeps those counters, then folds live ones.
  return compactCausal(expandFolded(c, retirements), retirements);
}

function compactState(state: ViewsState, retirements: VersionVector): ViewsState {
  const compactVersion = (v: ViewVersion): ViewVersion => withCausal(v, compactOne(causalOf(v), retirements));
  const views: ViewsState["views"] = {};
  for (const [id, entry] of Object.entries(state.views)) {
    views[id] = tidyEntry({
      current: compactVersion(entry.current),
      conflicts: entry.conflicts.map(compactVersion),
      hidden: entry.hidden ? compactOne(entry.hidden, retirements) : undefined,
    });
  }
  const dropped: ViewsState["dropped"] = {};
  for (const [id, causal] of Object.entries(state.dropped)) {
    const next = compactOne(causal, retirements);
    if (presentCausal(next)) dropped[id] = next;
  }
  const favorites = compactOne(favCausal({ ...state, retirements }), retirements);
  return withFavorites({ ...state, views, dropped, retirements }, favorites);
}

function collapseState(state: ViewsState, retirements: VersionVector): ViewsState {
  const collapseVersion = (v: ViewVersion): ViewVersion => withCausal(v, collapseFolded(causalOf(v), retirements));
  const views: ViewsState["views"] = {};
  for (const [id, entry] of Object.entries(state.views)) {
    views[id] = tidyEntry({
      current: collapseVersion(entry.current),
      conflicts: entry.conflicts.map(collapseVersion),
      hidden: entry.hidden ? collapseFolded(entry.hidden, retirements) : undefined,
    });
  }
  const dropped: ViewsState["dropped"] = {};
  for (const [id, causal] of Object.entries(state.dropped)) dropped[id] = collapseFolded(causal, retirements);
  const favorites = collapseFolded({ vv: state.favoritesVV, folded: state.favoritesFolded }, retirements);
  return withFavorites({ ...state, views, dropped, retirements }, favorites);
}

function withFavorites(state: ViewsState, favorites: Causal): ViewsState {
  const next: ViewsState = { ...state, favoritesVV: favorites.vv };
  if (favorites.folded && Object.keys(favorites.folded).length) next.favoritesFolded = favorites.folded;
  else delete next.favoritesFolded;
  if (favorites.foldedAll) next.favoritesFoldedAll = true;
  else delete next.favoritesFoldedAll;
  return next;
}

/**
 * Union `incoming` into the account retirement map, then fold devices a stamp has
 * actually observed. Stamps are expanded against the previous map first, so a stamp
 * that compacted an older map does not adopt retirements it never saw.
 */
export function adoptRetirements(state: ViewsState, incoming: VersionVector): ViewsState {
  const expanded = expandState(state);
  const retirements = unionRetirements([state.retirements, incoming]);
  return collapseState(compactState({ ...expanded, retirements }, retirements), retirements);
}

/** Save a local edit: validates the View and bumps this device's vector component. */
export function saveView(state: ViewsState, view: View): { state: ViewsState; notices: Notice[] } {
  if (!isSafeKey(view.id)) throw new Error("view id is empty or reserved");
  const loaded = loadView(view, noId);
  if (!loaded.ok) throw new Error(loaded.error);
  const prior = entryOf(state, view.id);
  // Editing while copies conflict would claim ancestry from copies the user has not chosen.
  if (prior && prior.conflicts.length) throw new Error("resolve conflicting copies first");
  const base = prior ? entryCausal(state, prior) : { vv: {} };
  // A new id, or a tombstoned one being brought back, takes a live slot.
  if (!prior || !isLiveEntry(prior)) {
    const { live } = countEntries(state);
    if (live >= VIEWS_MAX) throw new Error(`at most ${VIEWS_MAX} views`);
    if (!prior && Object.keys(state.views).length >= ENTRIES_MAX) throw new Error("too many deleted views are retained");
  }
  const current = withCausal({ id: view.id, vv: {}, view: loaded.view }, finishCausal(state, base));
  const views = { ...state.views, [view.id]: { current, conflicts: [] } };
  const dropped = clearDropped(state, view.id, current);
  return { state: collapseState(compactState({ ...state, views, dropped }, state.retirements), state.retirements), notices: loaded.notices };
}

/** Joined stamp of an entry, expanded against the account map the entry was saved with. */
function entryCausal(state: ViewsState, entry: ViewEntry): Causal {
  const map = state.retirements;
  return maxCausal(
    expandFolded(causalOf(entry.current), map),
    ...entry.conflicts.map((v) => expandFolded(causalOf(v), map)),
    entry.hidden ? expandFolded(entry.hidden, map) : undefined,
  );
}

function finishCausal(state: ViewsState, base: Causal): Causal {
  return { vv: bumpVV(materializeCausal(base), state.deviceId) };
}

/** A new version that dominates a dropped deletion retires that summary. */
function clearDropped(state: ViewsState, id: string, version: ViewVersion): ViewsState["dropped"] {
  const prior = state.dropped[id];
  if (!prior || !coversCausal(causalOf(version), expandFolded(prior, state.retirements))) return state.dropped;
  const dropped = { ...state.dropped };
  delete dropped[id];
  return dropped;
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
  const current = withCausal({ id, vv: {}, deleted: true }, finishCausal(state, entryCausal(state, prior)));
  const views = { ...state.views, [id]: { current, conflicts: [] } };
  return collapseState(compactState({ ...state, views, dropped: clearDropped(state, id, current) }, state.retirements), state.retirements);
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
  if (chosen.deleted && isLiveEntry(entry) && countEntries(state).tombstones >= TOMBSTONES_MAX) {
    throw new Error("too many deleted views are retained");
  }
  const finished = finishCausal(state, entryCausal(state, entry));
  const current = withCausal(chosen.deleted ? { id, vv: {}, deleted: true } : { id, vv: {}, view: chosen.view }, finished);
  const views = { ...state.views, [id]: { current, conflicts: [] } };
  return collapseState(compactState({ ...state, views, dropped: clearDropped(state, id, current) }, state.retirements), state.retirements);
}

/**
 * Merge an incoming version (from a backup or another device) into an entry. A version
 * dominated by a known one is ignored; one that dominates replaces those it dominates;
 * concurrent versions are kept as conflicting copies, except that versions with the same
 * content are joined into one.
 */
export function mergeVersion(entry: ViewEntry | undefined, incoming: ViewVersion): ViewEntry {
  return mergeVersionChecked(entry, incoming).entry;
}

/**
 * Same as mergeVersion, but reports `overflow` when more than CONFLICTS_MAX conflicting copies
 * exist; the first ones in canonical order are kept (independent of arrival order) and the
 * caller tells the user.
 */
export function mergeVersionChecked(entry: ViewEntry | undefined, incoming: ViewVersion, cover?: Causal): { entry: ViewEntry; overflow: boolean } {
  return mergeInner(entry, incoming, cover);
}

function versionKey(v: ViewVersion): string {
  return v.deleted ? "deleted" : canonicalJson(v.view);
}

function byCanonical(a: ViewVersion, b: ViewVersion): number {
  const x = canonicalJson(a);
  const y = canonicalJson(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** True when merging `incoming` did not change the copies or the hidden summary. */
function unchangedEntry(entry: ViewEntry, known: ViewVersion[], hidden: Causal | undefined): boolean {
  if (known.length !== 1 + entry.conflicts.length || known[0] !== entry.current) return false;
  for (let i = 0; i < entry.conflicts.length; i++) if (known[i + 1] !== entry.conflicts[i]) return false;
  return presentCausal(entry.hidden) === presentCausal(hidden);
}

function mergeInner(entry: ViewEntry | undefined, incoming: ViewVersion, cover?: Causal): { entry: ViewEntry; overflow: boolean } {
  const incomingCausal = causalOf(incoming);
  const hidden = presentCausal(maxCausal(entry?.hidden, cover));
  const known = (entry ? [entry.current, ...entry.conflicts] : []).filter((v) => !(hidden && coversCausal(hidden, causalOf(v))));
  if (hidden && coversCausal(hidden, incomingCausal)) {
    if (known.length === 0) {
      return { entry: { current: withCausal({ id: incoming.id, vv: {}, deleted: true }, hidden), conflicts: [] }, overflow: false };
    }
    if (entry && unchangedEntry(entry, known, hidden)) return { entry, overflow: false };
    const [current, ...conflicts] = known;
    return { entry: tidyEntry({ current: current!, conflicts, hidden }), overflow: false };
  }
  if (known.length === 0) return { entry: tidyEntry({ current: incoming, conflicts: [], hidden }), overflow: false };
  if (known.some((k) => coversCausal(causalOf(k), incomingCausal))) {
    if (entry && unchangedEntry(entry, known, hidden)) return { entry, overflow: false };
    const [current, ...conflicts] = known;
    return { entry: tidyEntry({ current: current!, conflicts, hidden }), overflow: false };
  }
  const survivors = known.filter((k) => !coversCausal(incomingCausal, causalOf(k)));
  // Concurrent versions with the same content agree (two devices making the same edit, or
  // concurrent deletions): join their vectors into one version instead of a conflict.
  const byContent = new Map<string, ViewVersion>();
  for (const v of [incoming, ...survivors]) {
    const key = versionKey(v);
    const prev = byContent.get(key);
    byContent.set(key, prev ? withCausal(prev, maxCausal(causalOf(prev), causalOf(v))) : v);
  }
  // Deterministic order, so replicas that know the same versions show the same current one.
  const all = [...byContent.values()].sort(byCanonical);
  const kept = all.slice(0, 1 + CONFLICTS_MAX);
  const dropped = all.slice(1 + CONFLICTS_MAX);
  const [current, ...conflicts] = kept;
  const nextHidden = presentCausal(dropped.reduce<Causal | undefined>((h, v) => maxCausal(h, causalOf(v)), hidden));
  return { entry: tidyEntry({ current: current!, conflicts, hidden: nextHidden }), overflow: dropped.length > 0 };
}

/** Drop view versions a removed tombstone already dominates, leaving the summary in `dropped`. */
export function applyDropped(state: ViewsState): ViewsState {
  const views = { ...state.views };
  for (const [id, causal] of Object.entries(state.dropped)) {
    const cover = expandFolded(causal, state.retirements);
    const entry = Object.hasOwn(views, id) ? views[id] : undefined;
    if (!entry) continue;
    const keep = [entry.current, ...entry.conflicts].filter((v) => !coversCausal(cover, expandFolded(causalOf(v), state.retirements)));
    if (keep.length === 0) {
      delete views[id];
      continue;
    }
    const [current, ...conflicts] = keep;
    views[id] = tidyEntry({ current: current!, conflicts, hidden: presentCausal(maxCausal(entry.hidden, cover)) });
  }
  return { ...state, views };
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
 * Order for recents, used everywhere: later `at` first; on equal times, the greater full
 * reference first. Negative means `a` comes first (and wins deduplication).
 */
export function compareRecent(a: RecentEntry, b: RecentEntry): number {
  if (a.at !== b.at) return b.at - a.at;
  const x = formatShareable(a.ref);
  const y = formatShareable(b.ref);
  return x > y ? -1 : x < y ? 1 : 0;
}

/**
 * Merge recents and favorites from a backup. Recents are combined by most recent `at`,
 * unique and capped. Favorites are merged as one versioned list: copies dominated by another
 * copy are dropped (so a removal wins over the stale copy it replaced), and only truly
 * concurrent copies are combined. Input is validated like stored state.
 */
export function mergePrefs(state: ViewsState, incoming: unknown[]): ViewsState {
  // All inputs are aggregated and ordered before capping, so the result does not depend on
  // the order of the backups.
  const parsed = incoming.map(
    (one) => parseState({ ...(isRecord(one) ? one : {}), owner: state.owner, v: 1, views: {} }, state.owner, state.deviceId).state,
  );
  // Full shareable form, so references that differ only in binding hints still sort deterministically.
  const key = (r: SourceRef) => formatShareable(r);
  const recents: RecentEntry[] = [];
  const allRecents = [...state.recents, ...parsed.flatMap((p) => p.recents)].sort(compareRecent);
  for (const r of allRecents) if (!recents.some((x) => sameSource(x.ref, r.ref))) recents.push(r);
  const stamp = (s: ViewsState): Causal => expandFolded({ vv: s.favoritesVV, folded: s.favoritesFolded, foldedAll: s.favoritesFoldedAll }, s.retirements);
  const copies = [{ favorites: state.favorites, causal: stamp(state), local: true }, ...parsed.map((p) => ({ favorites: p.favorites, causal: stamp(p), local: false }))];
  const survivors = copies.filter((c) => !copies.some((o) => o !== c && (compareCausal(c.causal, o.causal) === "before" || (compareCausal(c.causal, o.causal) === "equal" && !c.local && o.local))));
  // A single surviving copy is kept as is. Concurrent copies are combined in one deterministic
  // order before capping, so every replica that sees the same copies keeps the same list.
  let favorites: SourceRef[] = [];
  if (survivors.length === 1) favorites = [...survivors[0]!.favorites];
  else {
    const all = survivors.flatMap((c) => c.favorites).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    for (const f of all) if (!favorites.some((x) => sameSource(x, f))) favorites.push(f);
  }
  const dropped: ViewsState["dropped"] = {};
  for (const s of [state, ...parsed]) {
    for (const [id, causal] of Object.entries(s.dropped)) {
      dropped[id] = maxCausal(dropped[id], expandFolded(causal, s.retirements));
    }
  }
  const favoritesCausal = maxCausal(...copies.map((c) => c.causal));
  return withFavorites(
    {
      ...state,
      recents: recents.slice(0, RECENTS_MAX),
      favorites: favorites.slice(0, FAVORITES_MAX),
      dropped,
    },
    favoritesCausal,
  );
}

/** Record that a source was opened or added. Most recent first, unique, capped. */
export function touchRecent(state: ViewsState, ref: SourceRef, at: number): ViewsState {
  const checked = validateSourceRef(ref);
  if (!checked.ok) throw new Error(checked.error);
  if (!Number.isFinite(at)) throw new Error("invalid time");
  const prior = state.recents.find((r) => sameSource(r.ref, ref));
  const incoming = { ref: checked.value, at };
  // The later event wins with its own reference; on a tie, the greater full reference wins.
  const entry = prior && compareRecent(prior, incoming) < 0 ? prior : incoming;
  const recents = [entry, ...state.recents.filter((r) => !sameSource(r.ref, ref))].sort(compareRecent).slice(0, RECENTS_MAX);
  return { ...state, recents };
}

export function isFavorite(state: ViewsState, ref: SourceRef): boolean {
  return state.favorites.some((f) => sameSource(f, ref));
}

export function toggleFavorite(state: ViewsState, ref: SourceRef): ViewsState {
  const checked = validateSourceRef(ref);
  if (!checked.ok) throw new Error(checked.error);
  const favoritesVV = bumpVV(materializeCausal(favCausal(state)), state.deviceId);
  const base = withFavorites(state, { vv: favoritesVV });
  if (isFavorite(state, ref)) {
    return collapseState(compactState({ ...base, favorites: state.favorites.filter((f) => !sameSource(f, ref)) }, state.retirements), state.retirements);
  }
  if (state.favorites.length >= FAVORITES_MAX) throw new Error(`at most ${FAVORITES_MAX} favorites`);
  return collapseState(compactState({ ...base, favorites: [...state.favorites, checked.value] }, state.retirements), state.retirements);
}

/* ---------- persistence ---------- */

export type ViewsStore = {
  /**
   * Read the state, apply `fn`, and write the result, as one serialized step across tabs.
   * Returns the new state.
   */
  /** Notices are those from validating the stored state before `fn` ran. */
  update(owner: string, deviceId: string, fn: (state: ViewsState) => ViewsState): Promise<{ state: ViewsState; notices: Notice[] }>;
  read(owner: string, deviceId: string): Promise<{ state: ViewsState; notices: Notice[] }>;
};

type Lock = <T>(name: string, run: () => Promise<T>) => Promise<T>;

/** Shared by every fallback lock in this process, so separate callers still serialize. */
const fallbackTails = new Map<string, Promise<unknown>>();

/** Web Locks when available, otherwise an in-process queue (single tab or tests). */
export function defaultLock(): Lock {
  const locks = (globalThis.navigator as { locks?: { request: (n: string, cb: () => Promise<unknown>) => Promise<unknown> } } | undefined)?.locks;
  if (locks) return (name, run) => locks.request(name, run) as Promise<never>;
  const tails = fallbackTails;
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
        const { state, notices } = parseState(await io.get(key), key, deviceId);
        const next = fn(state);
        if (next.owner !== key) throw new Error("owner changed");
        await io.put(key, next);
        return { state: next, notices };
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
