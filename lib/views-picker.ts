/**
 * Picker logic for Views (docs/views.md §3, PR 3): the Browse tree, multi-select with
 * tri-state groups, kind filters, kind inference, and applying a selection to a View
 * (quick add with one window per source by default, or merging feeds, or adding to an
 * existing window). The dialog in components/ViewsPicker.tsx renders this.
 */
import { formatCanonical, sameSource, type SourceKind, type SourceRef } from "./views-source-ref";
import { loadView, MAX_SOURCES_PER_WINDOW, MAX_WINDOWS, type View, type ViewWindow } from "./views-window";

/** A source the picker can show, with its display label. */
export type PickerSource = { ref: SourceRef; label: string };

export type BrowseNode = {
  /** Unique within the tree. */
  id: string;
  label: string;
  /** Set on leaves only. */
  source?: PickerSource;
  children?: BrowseNode[];
};

export type PickerTab = "recents" | "favorites" | "browse";

/** Where picked sources go: a new window (kind inferred unless set) or an existing one. */
export type PickTarget = { type: "new"; kind?: SourceKind } | { type: "window"; windowId: string };

export function sourceKey(ref: SourceRef): string {
  return formatCanonical(ref);
}

/** Short owner label: wallets as 0xA1…ff, anything else up to 24 characters. */
export function shortOwner(owner: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(owner)) return `${owner.slice(0, 4)}…${owner.slice(-2)}`;
  return owner.length > 24 ? `${owner.slice(0, 23)}…` : owner;
}

const PROTOCOL_LABELS: Record<string, string> = {
  atproto: "ATProto",
  farcaster: "Farcaster",
  nostr: "Nostr",
  activitypub: "ActivityPub",
  rss: "RSS",
};

/** Host of an `s3rch:` network, for labels. */
export function networkHost(network: string): string {
  const m = /^s3rch:https:\/\/([^:;]+)/.exec(network);
  return m ? m[1]! : network;
}

function byLabel(a: { label: string; id: string }, b: { label: string; id: string }): number {
  return a.label.localeCompare(b.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Browse tree: Networks → owners → sources, grouped as This network, Other s3r.ch networks
 * and Protocols. Empty groups are left out. Duplicate sources are listed once.
 */
export function buildBrowseTree(sources: PickerSource[], selfNetwork: string, me?: string): BrowseNode[] {
  const seen = new Set<string>();
  const unique = sources.filter((s) => {
    const k = sourceKey(s.ref);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const owners = (list: PickerSource[], prefix: string): BrowseNode[] => {
    const byOwner = new Map<string, PickerSource[]>();
    for (const s of list) byOwner.set(s.ref.owner, [...(byOwner.get(s.ref.owner) ?? []), s]);
    return [...byOwner.entries()]
      .map(([owner, items]) => ({
        id: `${prefix}/${owner}`,
        label: me && owner.toLowerCase() === me.toLowerCase() ? `Me (${shortOwner(owner)})` : shortOwner(owner),
        children: items.map((s) => ({ id: sourceKey(s.ref), label: s.label, source: s })).sort(byLabel),
      }))
      .sort(byLabel);
  };
  const networks = (list: PickerSource[], prefix: string, label: (n: string) => string): BrowseNode[] => {
    const byNet = new Map<string, PickerSource[]>();
    for (const s of list) byNet.set(s.ref.network, [...(byNet.get(s.ref.network) ?? []), s]);
    return [...byNet.entries()].map(([n, items]) => ({ id: `${prefix}/${n}`, label: label(n), children: owners(items, `${prefix}/${n}`) })).sort(byLabel);
  };
  const self = unique.filter((s) => s.ref.network === selfNetwork);
  const other = unique.filter((s) => s.ref.network !== selfNetwork && s.ref.network.startsWith("s3rch:"));
  const protocols = unique.filter((s) => !s.ref.network.startsWith("s3rch:"));
  const out: BrowseNode[] = [];
  if (self.length) out.push({ id: "self", label: `This network (${networkHost(selfNetwork)})`, children: owners(self, "self") });
  if (other.length) out.push({ id: "other", label: "Other s3r.ch networks", children: networks(other, "other", networkHost) });
  if (protocols.length) out.push({ id: "protocols", label: "Protocols", children: networks(protocols, "protocols", (n) => PROTOCOL_LABELS[n] ?? n) });
  return out;
}

/** Every source below a node (the node itself if it is a leaf). */
export function leavesOf(node: BrowseNode): PickerSource[] {
  if (node.source) return [node.source];
  return (node.children ?? []).flatMap(leavesOf);
}

/** Keep only leaves that pass `keep`; branches left empty are dropped. */
export function filterTree(nodes: BrowseNode[], keep: (s: PickerSource) => boolean): BrowseNode[] {
  const out: BrowseNode[] = [];
  for (const n of nodes) {
    if (n.source) {
      if (keep(n.source)) out.push(n);
      continue;
    }
    const children = filterTree(n.children ?? [], keep);
    if (children.length) out.push({ ...n, children });
  }
  return out;
}

export type TreeRow = { node: BrowseNode; depth: number; parentId?: string; expanded: boolean };

/** Rows a user can see with the given expanded branches, in display order. */
export function visibleRows(nodes: BrowseNode[], expanded: ReadonlySet<string>, depth = 0, parentId?: string): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const node of nodes) {
    const open = !node.source && expanded.has(node.id);
    rows.push({ node, depth, parentId, expanded: open });
    if (open) rows.push(...visibleRows(node.children ?? [], expanded, depth + 1, node.id));
  }
  return rows;
}

/* ---------- selection ---------- */

export function isSelected(selection: PickerSource[], ref: SourceRef): boolean {
  return selection.some((s) => sameSource(s.ref, ref));
}

/** Add or remove one source. Selection keeps pick order. */
export function toggleSource(selection: PickerSource[], source: PickerSource): PickerSource[] {
  return isSelected(selection, source.ref) ? selection.filter((s) => !sameSource(s.ref, source.ref)) : [...selection, source];
}

export type TriState = "checked" | "unchecked" | "mixed";

export function triState(selection: PickerSource[], sources: PickerSource[]): TriState {
  if (sources.length === 0) return "unchecked";
  const n = sources.filter((s) => isSelected(selection, s.ref)).length;
  return n === 0 ? "unchecked" : n === sources.length ? "checked" : "mixed";
}

/** Group toggle: clears the group when all of it is selected, otherwise selects the rest. */
export function toggleGroup(selection: PickerSource[], sources: PickerSource[]): PickerSource[] {
  if (triState(selection, sources) === "checked") return selection.filter((s) => !sources.some((x) => sameSource(x.ref, s.ref)));
  return [...selection, ...sources.filter((s) => !isSelected(selection, s.ref))];
}

/* ---------- kinds ---------- */

/** The kind a new window takes: the kind of the first source chosen. */
export function inferKind(selection: PickerSource[]): SourceKind | null {
  return selection[0]?.ref.kind ?? null;
}

/**
 * Kinds a new window may be set to for this selection. A window holds only sources of its
 * own kind, so the only compatible override is the sources' shared kind; a mixed
 * selection can only go into one window per source.
 */
export function compatibleKinds(selection: PickerSource[]): SourceKind[] {
  const kinds = new Set(selection.map((s) => s.ref.kind));
  return kinds.size === 1 ? [...kinds] : [];
}

/** "Merge feeds into one window" is offered only when every selected source is a feed. */
export function canMergeFeeds(selection: PickerSource[]): boolean {
  return selection.length >= 2 && selection.length <= MAX_SOURCES_PER_WINDOW && selection.every((s) => s.ref.kind === "feed");
}

/** Kinds the picker should show for a target: an existing window takes its own kind only. */
export function kindsForTarget(view: View, target: PickTarget): SourceKind[] | null {
  if (target.type === "new") return target.kind ? [target.kind] : null;
  const w = view.windows.find((x) => x.id === target.windowId);
  return w ? [w.kind] : [];
}

/** Whether an existing window can take another source (stream and voice hold one; cap 8). */
export function canAccept(w: ViewWindow): boolean {
  return w.kind !== "stream" && w.kind !== "voice" && w.sources.length < MAX_SOURCES_PER_WINDOW;
}

/** Whether a source can be picked for a target: right kind, and not already in that window. */
export function pickable(view: View, target: PickTarget, ref: SourceRef): boolean {
  if (target.type === "new") return !target.kind || ref.kind === target.kind;
  const w = view.windows.find((x) => x.id === target.windowId);
  return !!w && ref.kind === w.kind && !w.sources.some((x) => sameSource(x, ref));
}

/**
 * How many sources a target can still take: for a new target, the free window slots (one
 * window per source; a merged feed window needs one slot); for an existing window, its
 * free source slots.
 */
export function capacity(view: View, target: PickTarget): number {
  if (target.type === "new") return Math.max(0, MAX_WINDOWS - view.windows.length);
  const w = view.windows.find((x) => x.id === target.windowId);
  return w && canAccept(w) ? MAX_SOURCES_PER_WINDOW - w.sources.length : 0;
}

/** Whether `count` selected sources fit the target (`merge`: one merged feed window). */
export function fits(view: View, target: PickTarget, count: number, merge: boolean): boolean {
  const cap = capacity(view, target);
  return target.type === "new" && merge ? cap >= 1 : count <= cap;
}

/* ---------- applying a pick ---------- */

export type PickResult = { ok: true; view: View; windowIds: string[] } | { ok: false; error: string };

/**
 * Apply a selection to a View.
 * - New window: one window per source (split windows, the default), or one merged feed
 *   window when `merge` is set and every source is a feed. A kind override must match.
 * - Existing window: sources of the window's kind are added; a single chat, forum or feed
 *   window becomes tabs, a merged feed window stays merged. Stream and voice windows hold
 *   one source. Sources already in the window are skipped.
 * The result is validated as a whole; nothing is changed on error.
 */
export function applyPick(view: View, target: PickTarget, selection: PickerSource[], opts: { merge?: boolean; newId: () => string }): PickResult {
  if (selection.length === 0) return { ok: false, error: "Nothing selected" };
  let windows: ViewWindow[];
  let touched: string[];
  if (target.type === "new") {
    if (target.kind && selection.some((s) => s.ref.kind !== target.kind)) return { ok: false, error: `Only ${target.kind} sources fit a ${target.kind} window` };
    const used = new Set(view.windows.map((w) => w.id));
    const fresh = () => {
      let id = opts.newId();
      while (id === "" || used.has(id)) id = opts.newId();
      used.add(id);
      return id;
    };
    let added: ViewWindow[];
    if (opts.merge) {
      if (!canMergeFeeds(selection)) return { ok: false, error: `Merging needs 2 to ${MAX_SOURCES_PER_WINDOW} feeds` };
      added = [{ id: fresh(), kind: "feed", mode: "merged", sources: selection.map((s) => s.ref) }];
    } else {
      added = selection.map((s) => ({ id: fresh(), kind: s.ref.kind, mode: "single" as const, sources: [s.ref], label: s.label }));
    }
    if (view.windows.length + added.length > MAX_WINDOWS) return { ok: false, error: `A view holds at most ${MAX_WINDOWS} windows` };
    windows = [...view.windows, ...added];
    touched = added.map((w) => w.id);
  } else {
    const w = view.windows.find((x) => x.id === target.windowId);
    if (!w) return { ok: false, error: "That window no longer exists" };
    if (selection.some((s) => s.ref.kind !== w.kind)) return { ok: false, error: `Only ${w.kind} sources fit this window` };
    const extra = selection.map((s) => s.ref).filter((r) => !w.sources.some((x) => sameSource(x, r)));
    if (extra.length === 0) return { ok: false, error: "Already in this window" };
    if (w.kind === "stream" || w.kind === "voice") return { ok: false, error: `A ${w.kind} window holds one source` };
    const sources = [...w.sources, ...extra];
    if (sources.length > MAX_SOURCES_PER_WINDOW) return { ok: false, error: `A window holds at most ${MAX_SOURCES_PER_WINDOW} sources` };
    const mode = w.mode === "merged" ? "merged" : "tabs";
    windows = view.windows.map((x) => (x.id === w.id ? { ...w, sources, mode } : x));
    touched = [w.id];
  }
  const loaded = loadView({ ...view, windows }, opts.newId);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  if (loaded.view.windows.length !== windows.length) return { ok: false, error: loaded.notices[0]?.message ?? "Invalid window" };
  return { ok: true, view: loaded.view, windowIds: touched };
}

/** Label for a reference: the known source label, else its source id. */
export function labelFor(ref: SourceRef, known: PickerSource[]): string {
  return known.find((s) => sameSource(s.ref, ref))?.label ?? ref.source;
}
