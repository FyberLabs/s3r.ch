/**
 * Window decorators for Views (docs/views.md §3.1, §3.5, PR 5): source color, label and
 * origin badge, and the merged feed order.
 *
 * Colors come from a fixed palette, never from stored CSS: `colorBy` maps a canonical
 * SourceRef to a palette name, and anything else falls back to a color derived from the
 * reference. Color is never the only cue; every chip also carries its text label.
 */
import { formatCanonical, type SourceRef } from "./views-source-ref";
import type { ViewRow } from "./views-adapters";
import type { ViewWindow } from "./views-window";

export const SOURCE_PALETTE = ["amber", "teal", "violet", "rose", "lime", "sky", "orange", "slate"] as const;
export type SourceColor = (typeof SOURCE_PALETTE)[number];

export function isSourceColor(value: unknown): value is SourceColor {
  return typeof value === "string" && (SOURCE_PALETTE as readonly string[]).includes(value);
}

/** FNV-1a over the canonical reference, for a stable default color. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Color of a source in a window: the window's `colorBy` choice when it names a palette color,
 * otherwise the first palette color not yet used in this window, starting from the
 * reference's hash, so sources in one window differ while there are colors left.
 */
export function sourceColor(window: ViewWindow, ref: SourceRef): SourceColor {
  const key = formatCanonical(ref);
  const chosen = window.colorBy && Object.hasOwn(window.colorBy, key) ? window.colorBy[key] : undefined;
  if (isSourceColor(chosen)) return chosen;
  return defaultColors(window).get(key) ?? SOURCE_PALETTE[hash(key) % SOURCE_PALETTE.length]!;
}

function defaultColors(window: ViewWindow): Map<string, SourceColor> {
  const used = new Set<SourceColor>();
  const out = new Map<string, SourceColor>();
  const keys = window.sources.map(formatCanonical);
  for (const k of keys) {
    const c = window.colorBy && Object.hasOwn(window.colorBy, k) ? window.colorBy[k] : undefined;
    if (isSourceColor(c)) used.add(c);
  }
  for (const k of keys) {
    const c = window.colorBy && Object.hasOwn(window.colorBy, k) ? window.colorBy[k] : undefined;
    if (isSourceColor(c)) continue;
    const start = hash(k) % SOURCE_PALETTE.length;
    let pick: SourceColor = SOURCE_PALETTE[start]!;
    for (let i = 0; i < SOURCE_PALETTE.length; i++) {
      const cand = SOURCE_PALETTE[(start + i) % SOURCE_PALETTE.length]!;
      if (!used.has(cand)) {
        pick = cand;
        break;
      }
    }
    used.add(pick);
    out.set(k, pick);
  }
  return out;
}

const PROTOCOL_NAMES: Record<string, string> = {
  atproto: "Bluesky",
  farcaster: "Farcaster",
  nostr: "Nostr",
  activitypub: "ActivityPub",
  rss: "RSS",
};

/** Short owner label: wallets as 0xA1…ff, anything else up to 24 characters. */
export function shortOwner(owner: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(owner)) return `${owner.slice(0, 4)}…${owner.slice(-2)}`;
  return owner.length > 24 ? `${owner.slice(0, 23)}…` : owner;
}

/** Network label: the host for s3r.ch networks, the protocol name otherwise. */
export function networkLabel(network: string): string {
  const m = /^s3rch:https:\/\/([^:;]+)/.exec(network);
  if (m) return m[1]!;
  return PROTOCOL_NAMES[network] ?? network;
}

/** Origin badge `network › owner`. */
export function originBadge(ref: SourceRef): string {
  return `${networkLabel(ref.network)} › ${shortOwner(ref.owner)}`;
}

/** Window title: its label, else the single source's label, else the kind with a count. */
export function windowTitle(window: ViewWindow, labelOf: (ref: SourceRef) => string): string {
  if (window.label) return window.label;
  if (window.sources.length === 1) return labelOf(window.sources[0]!);
  return `${window.kind} · ${window.sources.length} sources`;
}

/** A row from a source, with the time the client observed (fetched or received) it. */
export type ObservedRow = { row: ViewRow; observedAt: number };

/**
 * Merged feed order (docs/views.md §3.5): newest first by `ts` clamped to the observed time,
 * so a future timestamp cannot pin a row to the top; ties by observed time, then by key.
 * Duplicate keys are listed once. Times are Unix seconds.
 */
export function mergeFeedRows(rows: ObservedRow[], limit = 200): ViewRow[] {
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    if (seen.has(r.row.key)) return false;
    seen.add(r.row.key);
    return true;
  });
  const at = (r: ObservedRow) => Math.min(r.row.ts, r.observedAt);
  return unique
    .sort((a, b) => at(b) - at(a) || b.observedAt - a.observedAt || (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0))
    .slice(0, limit)
    .map((r) => r.row);
}
