/**
 * Window and View schema validation for Views. See docs/views.md §2.
 *
 * Invalid windows are dropped with a notice, never repaired silently. After drops the
 * layout is repaired; if it cannot be, the default grid is used.
 */
import { isSourceKind, sameSource, validateSourceRef, type SourceKind, type SourceRef } from "./views-source-ref";

export const MAX_WINDOWS = 12;
export const MAX_SOURCES_PER_WINDOW = 8;
export const MAX_LAYOUT_DEPTH = 8;
export const MAX_LAYOUT_NODES = 2 * MAX_WINDOWS;

export type WindowMode = "single" | "tabs" | "merged";

export type ViewWindow = {
  id: string;
  kind: SourceKind;
  sources: SourceRef[];
  mode: WindowMode;
  label?: string;
  colorBy?: Record<string, string>;
};

export type LayoutTree =
  | { type: "leaf"; windowId: string }
  | { type: "split"; dir: "row" | "col"; sizes: number[]; children: LayoutTree[] };

export type View = { id: string; title: string; windows: ViewWindow[]; layout: LayoutTree | null; v: 1 };

export type Notice = { windowId?: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TABBABLE: readonly SourceKind[] = ["chat", "forum", "feed"];

/** Validate one window's shape, kind and mode. Returns the window or the reason it is invalid. */
export function validateWindow(input: unknown): { ok: true; value: ViewWindow } | { ok: false; error: string } {
  if (!isRecord(input)) return { ok: false, error: "window is not an object" };
  const { id, kind, sources, mode, label, colorBy } = input;
  if (typeof id !== "string" || id === "") return { ok: false, error: "window id is empty" };
  if (!isSourceKind(kind)) return { ok: false, error: "unknown window kind" };
  if (mode !== "single" && mode !== "tabs" && mode !== "merged") return { ok: false, error: "unknown window mode" };
  if (!Array.isArray(sources)) return { ok: false, error: "sources is not a list" };
  if (sources.length > MAX_SOURCES_PER_WINDOW) return { ok: false, error: "too many sources" };
  const refs: SourceRef[] = [];
  for (const s of sources) {
    const r = validateSourceRef(s);
    if (!r.ok) return { ok: false, error: `invalid source: ${r.error}` };
    if (r.value.kind !== kind) return { ok: false, error: "source kind does not match window kind" };
    if (refs.some((x) => sameSource(x, r.value))) return { ok: false, error: "duplicate source" };
    refs.push(r.value);
  }
  if (mode === "single") {
    if (refs.length !== 1) return { ok: false, error: "single mode needs exactly 1 source" };
  } else {
    if (refs.length < 2) return { ok: false, error: `${mode} mode needs 2 to ${MAX_SOURCES_PER_WINDOW} sources` };
    if (mode === "tabs" && !TABBABLE.includes(kind)) return { ok: false, error: "tabs mode is only for chat, forum and feed" };
    if (mode === "merged" && kind !== "feed") return { ok: false, error: "merged mode is only for feed windows" };
  }
  const window: ViewWindow = { id, kind, sources: refs, mode };
  if (label !== undefined) {
    if (typeof label !== "string") return { ok: false, error: "label is not a string" };
    window.label = label;
  }
  if (colorBy !== undefined) {
    if (!isRecord(colorBy) || !Object.values(colorBy).every((c) => typeof c === "string")) {
      return { ok: false, error: "colorBy is invalid" };
    }
    window.colorBy = { ...(colorBy as Record<string, string>) };
  }
  return { ok: true, value: window };
}

/** Iterative bounds check, run before any recursive work on an untrusted layout. */
export function layoutWithinBounds(layout: unknown): boolean {
  const stack: { node: unknown; depth: number }[] = [{ node: layout, depth: 1 }];
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    count += 1;
    if (count > MAX_LAYOUT_NODES || depth > MAX_LAYOUT_DEPTH) return false;
    if (isRecord(node) && node.type === "split" && Array.isArray(node.children)) {
      if (node.children.length > MAX_LAYOUT_NODES) return false;
      for (const child of node.children) stack.push({ node: child, depth: depth + 1 });
    }
  }
  return true;
}

/** Default grid: one leaf, or a row of leaves with equal sizes. */
export function defaultLayout(windowIds: string[]): LayoutTree | null {
  if (windowIds.length === 0) return null;
  if (windowIds.length === 1) return { type: "leaf", windowId: windowIds[0]! };
  return {
    type: "split",
    dir: "row",
    sizes: windowIds.map(() => 1 / windowIds.length),
    children: windowIds.map((windowId) => ({ type: "leaf", windowId })),
  };
}

/**
 * Repair a bounded layout against the surviving window ids: drop leaves for unknown or
 * already-placed windows, remove empty splits, collapse single-child splits, renormalize
 * sizes, and append unplaced windows. Returns null only when there are no windows.
 */
export function repairLayout(layout: unknown, windowIds: string[], ambiguousIds: ReadonlySet<string> = new Set()): LayoutTree | null {
  if (windowIds.length === 0) return null;
  if (!layoutWithinBounds(layout)) return defaultLayout(windowIds);
  // Leaves naming an ambiguous (duplicated) id are dropped; those windows are re-appended.
  const alive = new Set(windowIds.filter((id) => !ambiguousIds.has(id)));
  const placed = new Set<string>();

  function walk(node: unknown): LayoutTree | null {
    if (!isRecord(node)) return null;
    if (node.type === "leaf") {
      const id = node.windowId;
      if (typeof id !== "string" || !alive.has(id) || placed.has(id)) return null;
      placed.add(id);
      return { type: "leaf", windowId: id };
    }
    if (node.type !== "split" || (node.dir !== "row" && node.dir !== "col") || !Array.isArray(node.children)) return null;
    const rawSizes = Array.isArray(node.sizes) ? node.sizes : [];
    const kids: LayoutTree[] = [];
    const sizes: number[] = [];
    node.children.forEach((child, i) => {
      const fixed = walk(child);
      if (!fixed) return;
      const s = rawSizes[i];
      kids.push(fixed);
      sizes.push(typeof s === "number" && Number.isFinite(s) && s > 0 ? s : 1);
    });
    if (kids.length === 0) return null;
    if (kids.length === 1) return kids[0]!;
    // Scale by the largest size first so the sum cannot overflow to Infinity.
    const max = Math.max(...sizes);
    const scaled = sizes.map((s) => s / max);
    const total = scaled.reduce((a, b) => a + b, 0);
    const normalized = scaled.map((s) => s / total);
    return {
      type: "split",
      dir: node.dir,
      sizes: normalized.every((s) => Number.isFinite(s) && s > 0) ? normalized : kids.map(() => 1 / kids.length),
      children: kids,
    };
  }

  let tree = walk(layout);
  const missing = windowIds.filter((id) => !placed.has(id));
  if (missing.length) {
    const leaves: LayoutTree[] = missing.map((windowId) => ({ type: "leaf", windowId }));
    if (!tree) tree = defaultLayout(missing);
    else if (tree.type === "split" && tree.dir === "row") {
      const prior = tree.children.length;
      const n = prior + leaves.length;
      tree = {
        type: "split",
        dir: "row",
        children: [...tree.children, ...leaves],
        sizes: [...tree.sizes.map((s) => (s * prior) / n), ...leaves.map(() => 1 / n)],
      };
    } else {
      const n = 1 + leaves.length;
      tree = { type: "split", dir: "row", children: [tree, ...leaves], sizes: [1 / n, ...leaves.map(() => 1 / n)] };
    }
  }
  if (!tree || !layoutWithinBounds(tree)) return defaultLayout(windowIds);
  return tree;
}

export type ViewLoadResult = { ok: true; view: View; notices: Notice[] } | { ok: false; error: string };

/**
 * Validate a View on create, load or import. Rejects a View with too many windows before
 * any other work; drops invalid windows with a notice; regenerates duplicate window ids
 * with a notice; repairs the layout.
 */
export function loadView(input: unknown, newId: () => string): ViewLoadResult {
  if (!isRecord(input)) return { ok: false, error: "view is not an object" };
  const { id, title, windows, layout, v } = input;
  if (v !== 1) return { ok: false, error: "unsupported version" };
  if (typeof id !== "string" || id === "") return { ok: false, error: "view id is empty" };
  if (typeof title !== "string") return { ok: false, error: "title is not a string" };
  if (!Array.isArray(windows)) return { ok: false, error: "windows is not a list" };
  if (windows.length > MAX_WINDOWS) return { ok: false, error: `more than ${MAX_WINDOWS} windows` };

  const notices: Notice[] = [];
  const kept: ViewWindow[] = [];
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  for (const raw of windows) {
    const r = validateWindow(raw);
    if (!r.ok) {
      const wid = isRecord(raw) && typeof raw.id === "string" ? raw.id : undefined;
      notices.push({ windowId: wid, message: `Window removed: ${r.error}` });
      continue;
    }
    const w = r.value;
    if (seen.has(w.id)) {
      ambiguous.add(w.id);
      let fresh = newId();
      while (fresh === "" || seen.has(fresh)) fresh = newId();
      notices.push({ windowId: fresh, message: `Duplicate window id ${w.id} replaced` });
      w.id = fresh;
    }
    seen.add(w.id);
    kept.push(w);
  }
  const ids = kept.map((w) => w.id);
  return { ok: true, view: { id, title, windows: kept, layout: repairLayout(layout, ids, ambiguous), v: 1 }, notices };
}
