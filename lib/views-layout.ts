/**
 * View route layout helpers (docs/views.md §6, PR 6): window order, split resizing, unread
 * counts, last-seen times and the focus keys (`F` maximize, `Esc` restore, `Alt+1..9`).
 */
import { canShowRows, settlePending, type AccessState } from "./views-access";
import type { ObservedRow } from "./views-decorators";
import { sameSource, type SourceRef } from "./views-source-ref";
import { listViews, saveView, type ViewsState } from "./views-store";
import { MAX_WINDOWS, type LayoutTree, type View, type ViewWindow } from "./views-window";

/** Smallest share a split child can be resized to. */
export const MIN_SPLIT_SIZE = 0.1;

/** Position of the border before child `i`: the sum of the shares before it, as a share of the split. */
export function boundary(sizes: number[], i: number): number {
  const total = sizes.reduce((a, b) => a + b, 0);
  return total > 0 ? sizes.slice(0, i).reduce((a, b) => a + b, 0) / total : 0;
}

/** Window ids in reading order (depth first, left to right). */
export function leafOrder(tree: LayoutTree | null): string[] {
  const out: string[] = [];
  const stack: LayoutTree[] = tree ? [tree] : [];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "leaf") out.push(node.windowId);
    else for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return out;
}

/** The smallest share for each of `n` children: MIN_SPLIT_SIZE, or less when they can't all fit. */
export function minShare(n: number): number {
  return Math.min(MIN_SPLIT_SIZE, 1 / (2 * n));
}

/**
 * Move the border after child `index` of the split at `path` (child indices from the root)
 * by `delta` (a share of that split). The child on the growing side takes the space; the
 * children on the other side give it up, nearest first, each down to `minShare`. An unknown
 * path or index, or a move with no room, returns the tree unchanged.
 */
export function resizeSplit(tree: LayoutTree, path: number[], index: number, delta: number): LayoutTree {
  if (!Number.isFinite(delta) || delta === 0) return tree;
  if (path.length) {
    if (tree.type !== "split") return tree;
    const [head, ...rest] = path;
    const child = tree.children[head!];
    if (!child) return tree;
    const next = resizeSplit(child, rest, index, delta);
    if (next === child) return tree;
    return { ...tree, children: tree.children.map((c, i) => (i === head ? next : c)) };
  }
  if (tree.type !== "split" || index < 0 || index + 1 >= tree.sizes.length) return tree;
  const sizes = tree.sizes.slice();
  const min = minShare(sizes.length);
  const grow = delta > 0 ? index : index + 1;
  const givers: number[] = [];
  if (delta > 0) for (let j = index + 1; j < sizes.length; j++) givers.push(j);
  else for (let j = index; j >= 0; j--) givers.push(j);
  let left = Math.abs(delta);
  for (const j of givers) {
    const take = Math.min(left, Math.max(0, sizes[j]! - min));
    sizes[j] = sizes[j]! - take;
    left -= take;
    if (left <= 0) break;
  }
  const moved = Math.abs(delta) - left;
  if (moved <= 0) return tree;
  sizes[grow] = sizes[grow]! + moved;
  return { ...tree, sizes };
}

/**
 * Whether `observedAt` is still unread at `seenAt`. Both are Unix seconds on one clock
 * and may be fractional. A whole-second observation only names the second it arrived in,
 * so it stays unread when the cursor is that same second — equal, or fractional and still
 * inside it. An earlier second was already on screen.
 */
export function observedAfterSeen(observedAt: number, seenAt: number): boolean {
  if (observedAt > seenAt || observedAt === seenAt) return true;
  return Number.isInteger(observedAt) && seenAt > observedAt && seenAt < observedAt + 1;
}

/**
 * New rows in a window since it was last seen: rows from its current, readable sources
 * first observed after `seenAt`, each key counted once. A window never seen has none.
 * Rows that share the cursor's second are kept (see `observedAfterSeen`).
 */
export function unreadCount(window: ViewWindow, rows: ObservedRow[], access: (ref: SourceRef) => AccessState, seenAt: number | undefined): number {
  if (seenAt === undefined) return 0;
  // A row seen again keeps its first observation, as in the merged feed.
  const first = new Map<string, ObservedRow>();
  for (const r of rows) {
    const prev = first.get(r.row.key);
    if (!prev || r.observedAt < prev.observedAt) first.set(r.row.key, r);
  }
  let n = 0;
  for (const r of first.values()) {
    if (!observedAfterSeen(r.observedAt, seenAt)) continue;
    if (!window.sources.some((s) => sameSource(s, r.row.source)) || !canShowRows(access(r.row.source))) continue;
    n++;
  }
  return n;
}

/** Unix seconds on the `observedAt` clock, keeping sub-second precision. */
export function seenNow(ms: number = Date.now()): number {
  return ms / 1000;
}

/**
 * Cursor for a window that has never been seen. Rows already stamped with the current
 * whole second stay seen; counting starts at the next second.
 */
export function seenBaseline(ms: number = Date.now()): number {
  return Math.floor(ms / 1000) + 1;
}

/**
 * Last-seen times by window id, as stored locally per View. Records have no prototype, so a
 * window id such as `__proto__` is an ordinary key.
 */
export type SeenTimes = Record<string, number>;

export function seenStorageKey(owner: string, viewId: string): string {
  return `s3rch-views-seen:${owner.toLowerCase()}:${viewId}`;
}

/** Parse stored last-seen times, keeping only finite times for the View's windows. */
export function parseSeen(raw: string | null, windowIds: string[]): SeenTimes {
  const out: SeenTimes = Object.create(null);
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    return out;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const id of windowIds.slice(0, MAX_WINDOWS)) {
    const t = (value as Record<string, unknown>)[id];
    if (Object.hasOwn(value, id) && typeof t === "number" && Number.isFinite(t) && t >= 0) out[id] = t;
  }
  return out;
}

/** Mark windows seen at `now`; windows never seen before start counting from now. */
export function markSeen(seen: SeenTimes, ids: string[], now: number): SeenTimes {
  const next: SeenTimes = Object.assign(Object.create(null), seen);
  for (const id of ids) next[id] = Math.max(Object.hasOwn(next, id) ? next[id]! : 0, now);
  return next;
}

/** Combine two sets of last-seen times (another tab's and ours), keeping the later time per window. */
export function mergeSeen(a: SeenTimes, b: SeenTimes): SeenTimes {
  const next: SeenTimes = Object.assign(Object.create(null), a);
  for (const id of Object.keys(b)) next[id] = Math.max(Object.hasOwn(next, id) ? next[id]! : 0, b[id]!);
  return next;
}

export type KeyInput = { key: string; code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; editable: boolean };
export type KeyAction = { type: "focus"; windowId: string } | { type: "maximize"; windowId: string } | { type: "restore" };

/**
 * What a key press on the View does. `F` (outside text fields) maximizes the focused window
 * or restores it; `Esc` restores; `Alt+1..9` focuses window N in reading order.
 */
export function keyAction(e: KeyInput, order: string[], focused: string | null, maximized: string | null): KeyAction | null {
  if (e.key === "Escape" && maximized) return { type: "restore" };
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit && e.altKey && !e.ctrlKey && !e.metaKey) {
    const id = order[Number(digit[1]) - 1];
    return id ? { type: "focus", windowId: id } : null;
  }
  if ((e.key === "f" || e.key === "F") && !e.altKey && !e.ctrlKey && !e.metaKey && !e.editable && focused) {
    return maximized === focused ? { type: "restore" } : { type: "maximize", windowId: focused };
  }
  return null;
}

/** The View the route opens: the live copy for `id`, flagged when copies conflict. */
export function openView(state: ViewsState, id: string): { view: View; conflicted: boolean } | null {
  return listViews(state).find((v) => v.view.id === id) ?? null;
}

/** Sources a picker edit added: those in `after`'s windows that the same window lacked before. */
export function addedSources(before: View, after: View): SourceRef[] {
  const out: SourceRef[] = [];
  for (const w of after.windows) {
    const old = before.windows.find((b) => b.id === w.id);
    for (const ref of w.sources) {
      if (old?.sources.some((s) => sameSource(s, ref))) continue;
      if (!out.some((s) => sameSource(s, ref))) out.push(ref);
    }
  }
  return out;
}

/** Windows with pending marks settled against current access (see settlePending); null if none change. */
export function settleView(view: View, access: (ref: SourceRef) => AccessState): View | null {
  const windows = view.windows.map((w) => settlePending(w, access));
  return windows.some((w, i) => w !== view.windows[i]) ? { ...view, windows } : null;
}

/**
 * Apply an edit to the stored View. A `checked` edit (made from what a tab shows) is refused
 * when the store holds something other than `known`, the copy that tab last read or wrote,
 * meaning another tab saved since. Returns the new state with the copies before and after.
 */
export function editView(state: ViewsState, id: string, known: View | null, edit: (view: View) => View, checked: boolean): { state: ViewsState; before: View; after: View } {
  const found = openView(state, id);
  if (!found) throw new Error("This View was deleted");
  if (checked && JSON.stringify(found.view) !== JSON.stringify(known)) throw new Error("This View changed in another tab. Reload and try again.");
  const after = edit(found.view);
  return { state: saveView(state, after).state, before: found.view, after };
}

/** Sizes that survive a save are normalized and can differ by a rounding error, not by a resize step. */
const LAYOUT_SIZE_EPS = 1e-9;

function sameLayoutNode(a: LayoutTree, b: LayoutTree): boolean {
  if (a.type === "leaf" || b.type === "leaf") return a.type === "leaf" && b.type === "leaf" && a.windowId === b.windowId;
  if (a.dir !== b.dir || a.sizes.length !== b.sizes.length || a.children.length !== b.children.length) return false;
  for (let i = 0; i < a.children.length; i++) {
    if (Math.abs(a.sizes[i]! - b.sizes[i]!) > LAYOUT_SIZE_EPS) return false;
    if (!sameLayoutNode(a.children[i]!, b.children[i]!)) return false;
  }
  return true;
}

export function sameLayout(a: LayoutTree | null, b: LayoutTree | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return sameLayoutNode(a, b);
}

/**
 * Whether a layout coming back from a save may replace the one on screen.
 * While a newer resize is still queued, only the layout that was submitted may land.
 * With nothing queued, the incoming layout wins, including a reload after a failed save.
 */
export function shouldAdoptSavedLayout(pendingSaves: number, incoming: LayoutTree | null, submitted: LayoutTree | null): boolean {
  if (pendingSaves <= 0) return true;
  return submitted !== null && sameLayout(incoming, submitted);
}

type LayoutSaveWaiter = { resolve: () => void; reject: (error: unknown) => void };

/**
 * Layouts pushed while a write is in flight. Only the newest is written next, and every
 * push's promise settles together: resolved when that newest layout is published, rejected
 * when a write fails.
 */
export type LayoutSaveQueue<T> = {
  /** Queue `layout`. `start` means the caller must drain, beginning with this layout. */
  push(layout: T): { start: boolean; done: Promise<void> };
  /** The in-flight write finished. Publish only when nothing newer is waiting. */
  wrote(): { publish: boolean; next: T | null };
  /** Drop the queue and reject every waiter. */
  fail(error: unknown): void;
};

export function createLayoutSaveQueue<T>(): LayoutSaveQueue<T> {
  let writing = false;
  let pending: T | null = null;
  let waiters: LayoutSaveWaiter[] = [];

  const settle = (error: unknown | null) => {
    const current = waiters;
    waiters = [];
    writing = false;
    pending = null;
    for (const waiter of current) {
      if (error === null) waiter.resolve();
      else waiter.reject(error);
    }
  };

  return {
    push(layout) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const done = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      waiters.push({ resolve, reject });
      if (writing) {
        pending = layout;
        return { start: false, done };
      }
      writing = true;
      return { start: true, done };
    },
    wrote() {
      if (!writing) return { publish: false, next: null };
      if (pending !== null) {
        const next = pending;
        pending = null;
        return { publish: false, next };
      }
      settle(null);
      return { publish: true, next: null };
    },
    fail(error) {
      settle(error);
    },
  };
}

/**
 * Persist queued layouts one at a time. A layout pushed while the write is in flight
 * replaces the one waiting, so keyboard auto-repeat does not save every step. `publish`
 * runs only for the write that is still the newest layout.
 */
export async function drainLayoutSaves<T>(
  queue: LayoutSaveQueue<T>,
  first: T,
  write: (layout: T) => Promise<T | null>,
  publish: (saved: T) => void,
): Promise<void> {
  let layout: T | null = first;
  try {
    while (layout) {
      const saved = await write(layout);
      if (saved === null) {
        queue.fail(new Error("layout save failed"));
        return;
      }
      const step = queue.wrote();
      if (step.publish) publish(saved);
      layout = step.next;
    }
  } catch (error) {
    queue.fail(error);
  }
}
