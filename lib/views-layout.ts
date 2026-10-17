/**
 * View route layout helpers (docs/views.md §6, PR 6): window order, split resizing, unread
 * counts, last-seen times and the focus keys (`F` maximize, `Esc` restore, `Alt+1..9`).
 */
import { canShowRows, type AccessState } from "./views-access";
import type { ObservedRow } from "./views-decorators";
import { sameSource, type SourceRef } from "./views-source-ref";
import { listViews, type ViewsState } from "./views-store";
import { MAX_WINDOWS, type LayoutTree, type View, type ViewWindow } from "./views-window";

/** Smallest share a split child can be resized to. */
export const MIN_SPLIT_SIZE = 0.1;

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

/**
 * Move the border after child `index` of the split at `path` (child indices from the root)
 * by `delta` (a share of that split). Both neighbours keep at least MIN_SPLIT_SIZE; other
 * children are unchanged. An unknown path or index returns the tree unchanged.
 */
export function resizeSplit(tree: LayoutTree, path: number[], index: number, delta: number): LayoutTree {
  if (!Number.isFinite(delta)) return tree;
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
  const a = tree.sizes[index]!;
  const b = tree.sizes[index + 1]!;
  const lo = Math.min(a, MIN_SPLIT_SIZE);
  const hi = Math.min(b, MIN_SPLIT_SIZE);
  const d = Math.max(lo - a, Math.min(b - hi, delta));
  if (d === 0) return tree;
  const sizes = tree.sizes.slice();
  sizes[index] = a + d;
  sizes[index + 1] = b - d;
  return { ...tree, sizes };
}

/**
 * New rows in a window since it was last seen: rows from its current, readable sources
 * observed after `seenAt`, each key counted once. A window never seen has none.
 */
export function unreadCount(window: ViewWindow, rows: ObservedRow[], access: (ref: SourceRef) => AccessState, seenAt: number | undefined): number {
  if (seenAt === undefined) return 0;
  const keys = new Set<string>();
  for (const r of rows) {
    if (r.observedAt <= seenAt || keys.has(r.row.key)) continue;
    if (!window.sources.some((s) => sameSource(s, r.row.source)) || !canShowRows(access(r.row.source))) continue;
    keys.add(r.row.key);
  }
  return keys.size;
}

/** Last-seen times by window id, as stored locally per View. */
export type SeenTimes = Record<string, number>;

export function seenStorageKey(owner: string, viewId: string): string {
  return `s3rch-views-seen:${owner.toLowerCase()}:${viewId}`;
}

/** Parse stored last-seen times, keeping only finite times for the View's windows. */
export function parseSeen(raw: string | null, windowIds: string[]): SeenTimes {
  const out: SeenTimes = {};
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
  const next = { ...seen };
  for (const id of ids) next[id] = Math.max(next[id] ?? 0, now);
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
