"use client";

/**
 * Desktop picker dialog for Views (docs/views.md §3.3, §3.4, §3.10). Step 1 chooses a new or
 * existing window (skipped when the caller fixes the target); step 2 chooses sources from
 * Recents, Favorites or the Browse tree, with kind filters and a selected tray.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { btnPrimary, btnSecondary, btnTabOff, btnTabOn, chipOff, chipOn } from "@/lib/brand-ui";
import {
  applyPick,
  canAccept,
  capacity,
  fits,
  pickable,
  buildBrowseTree,
  canMergeFeeds,
  filterTree,
  inferKind,
  isSelected,
  kindsForTarget,
  labelFor,
  leavesOf,
  sourceKey,
  toggleGroup,
  toggleSource,
  triState,
  visibleRows,
  type PickerSource,
  type PickerTab,
  type PickTarget,
} from "@/lib/views-picker";
import { SOURCE_KINDS, type SourceKind, type SourceRef } from "@/lib/views-source-ref";
import type { RecentEntry } from "@/lib/views-store";
import { originBadge } from "@/lib/views-decorators";
import { accessLabel, addsAsPending, canPick, type AccessState } from "@/lib/views-access";
import type { View } from "@/lib/views-window";

export type ViewsPickerProps = {
  view: View;
  /** Known sources for Browse (and labels for recents and favorites). */
  sources: PickerSource[];
  recents: RecentEntry[];
  favorites: SourceRef[];
  selfNetwork: string;
  me?: string;
  /** Fixed target (empty-slot "+", window "Add source"); without it step 1 is shown. */
  target?: PickTarget;
  initialTab?: PickerTab;
  /** Start on step 2 with a new-window target even without a fixed target (preview only). */
  startOnSources?: boolean;
  newId: () => string;
  /** Inline access state per source (docs/views.md §3.7). Without it, no badges are shown. */
  access?: (ref: SourceRef) => AccessState;
  onConfirm: (view: View, windowIds: string[]) => void;
  onClose: () => void;
};

const KIND_LABEL: Record<SourceKind, string> = { chat: "Chat", forum: "Forum", feed: "Feed", stream: "Stream", voice: "Voice" };


export function ViewsPicker(props: ViewsPickerProps) {
  const { view, sources, recents, favorites, selfNetwork, me, newId, onConfirm, onClose, access } = props;
  const pickOk = (s: PickerSource) => !access || canPick(access(s.ref));
  const pickableOf = (list: PickerSource[]) => list.filter(pickOk);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<1 | 2>(props.target || props.startOnSources ? 2 : 1);
  const [target, setTarget] = useState<PickTarget>(props.target ?? { type: "new" });
  const [tab, setTab] = useState<PickerTab>(props.initialTab ?? (props.target?.type === "window" ? "browse" : "recents"));
  const [kinds, setKinds] = useState<SourceKind[]>([]);
  const [selection, setSelection] = useState<PickerSource[]>([]);
  const [merge, setMerge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["self", ...(me ? [`self/${me}`] : [])]));
  const [focusKey, setFocusKey] = useState<string | null>(null);

  // Esc closes; focus stays inside the dialog; focus returns to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus?.();
  }, []);
  // Focus the first control of each step, so focus never falls outside the dialog.
  useEffect(() => {
    const d = dialogRef.current;
    (d?.querySelector<HTMLElement>("[data-autofocus]:not([disabled])") ?? d?.querySelector<HTMLElement>("[data-step] input:not([disabled]), [data-step] button:not([disabled])"))?.focus();
  }, [step]);

  // A new destination clears the kind filters and drops selected sources that no longer fit.
  function chooseTarget(t: PickTarget) {
    setTarget(t);
    setKinds([]);
    setSelection((sel) => sel.filter((s) => pickable(view, t, s.ref)));
    setError(null);
  }
  function onDialogKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    // Only elements reachable by Tab (tree controls with tabIndex -1 are not).
    const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]") ?? [])].filter(
      (el) => el.tabIndex >= 0 && !isSkippedRadio(el),
    );
    if (!items.length) return;
    // Tab is handled here for every position, so focus always cycles inside the dialog, even
    // from an element focused by pointer that is not itself in the tab order.
    const active = document.activeElement;
    let idx = active ? items.findIndex((el) => el === active || el.contains(active)) : -1;
    if (idx === -1 && active) {
      // The last tabbable element before the focused one (-1 if none).
      idx = items.reduce((at, el, i) => (el.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING ? i : at), -1);
    }
    const n = items.length;
    const next = e.shiftKey ? (idx <= 0 ? n - 1 : idx - 1) : (idx + 1) % n;
    e.preventDefault();
    items[next]!.focus();
  }

  const targetKinds = kindsForTarget(view, target);
  // Only sources that would actually be added: right kind and not already in the target window.
  const passes = (s: PickerSource) => capacity(view, target) > 0 && pickable(view, target, s.ref) && (kinds.length === 0 || kinds.includes(s.ref.kind));
  const known = useMemo(() => [...sources, ...recents.map((r) => ({ ref: r.ref, label: labelFor(r.ref, sources) }))], [sources, recents]);
  const tree = useMemo(() => filterTree(buildBrowseTree(sources, selfNetwork, me), passes), [sources, selfNetwork, me, kinds, view, target]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = visibleRows(tree, expanded);
  // The focused row, falling back to the first visible one when a filter removed it.
  const activeKey = rows.some((r) => r.node.id === focusKey) ? focusKey : (rows[0]?.node.id ?? null);
  const flat: PickerSource[] =
    tab === "recents"
      ? recents.map((r) => ({ ref: r.ref, label: labelFor(r.ref, known) })).filter(passes)
      : tab === "favorites"
        ? favorites.map((f) => ({ ref: f, label: labelFor(f, known) })).filter(passes)
        : [];

  const mergeable = target.type === "new" && canMergeFeeds(selection);
  const room = capacity(view, target);
  const fitsTarget = fits(view, target, selection.length, mergeable && merge);
  const windowKind = target.type === "new" ? target.kind ?? inferKind(selection) : view.windows.find((w) => w.id === target.windowId)?.kind;

  function toggle(s: PickerSource) {
    setError(null);
    setSelection((sel) => toggleSource(sel, s));
  }

  function confirm() {
    // Access can change while the dialog is open (sign-out, lost connection).
    const stale = selection.filter((s) => !pickOk(s));
    if (stale.length) {
      setSelection((sel) => sel.filter(pickOk));
      return setError(stale.length === 1 ? `${stale[0]!.label} can no longer be added and was removed from the selection` : `${stale.length} sources can no longer be added and were removed from the selection`);
    }
    const r = applyPick(view, target, selection, { merge: mergeable && merge, newId, pending: access ? (ref) => addsAsPending(access(ref)) : undefined });
    if (!r.ok) return setError(r.error);
    onConfirm(r.view, r.windowIds);
  }

  function onTreeKey(e: KeyboardEvent<HTMLUListElement>) {
    const i = rows.findIndex((r) => r.node.id === activeKey);
    const row = rows[i];
    const move = (j: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (next) setFocusKey(next.node.id);
    };
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i - 1);
    else if (e.key === "ArrowRight" && row && !row.node.source) {
      if (!row.expanded) setExpanded((x) => new Set(x).add(row.node.id));
      else move(i + 1);
    } else if (e.key === "ArrowLeft" && row) {
      if (row.expanded) setExpanded((x) => { const n = new Set(x); n.delete(row.node.id); return n; });
      else if (row.parentId) setFocusKey(row.parentId);
    } else if (e.key === " " && row) {
      if (row.node.source) {
        if (pickOk(row.node.source)) toggle(row.node.source);
      } else setSelection((sel) => toggleGroup(sel, pickableOf(leavesOf(row.node))));
    } else if (e.key === "Enter" && selection.length && fitsTarget) confirm();
    else return;
    e.preventDefault();
  }

  useEffect(() => {
    if (focusKey) dialogRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(focusKey)}"]`)?.focus();
  }, [focusKey]);

  const heading =
    step === 1
      ? `Add to view: "${view.title}"`
      : target.type === "window"
        ? `Add sources → ${view.windows.find((w) => w.id === target.windowId)?.label ?? "window"}`
        : `Add sources → new window (${target.kind ? KIND_LABEL[target.kind] : windowKind ? `Auto: ${KIND_LABEL[windowKind]}` : "Auto"})`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,var(--ground)_70%,transparent)] p-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onDialogKey}
        className="instrument-panel flex max-h-[90vh] w-full max-w-4xl flex-col border border-rule bg-panel-strong text-ink shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-rule px-5 py-3">
          <h2 id={titleId} className="text-sm font-semibold">{heading}</h2>
          <button type="button" aria-label="Close" className="px-2 text-ink-muted hover:text-ink" onClick={onClose}>✕</button>
        </header>

        {step === 1 ? (
          <StepWindow view={view} target={target} onTarget={chooseTarget} onCancel={onClose} onNext={() => setStep(2)} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-rule px-5 py-3">
              <div role="tablist" aria-label="Source lists" className="flex gap-1">
                {(["recents", "favorites", "browse"] as const).map((t, i) => (
                  <button key={t} type="button" role="tab" aria-selected={tab === t} data-autofocus={i === 0 ? true : undefined} className={tab === t ? btnTabOn : btnTabOff} onClick={() => setTab(t)}>
                    {t === "recents" ? "Recents" : t === "favorites" ? "Favorites" : "Browse"}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex flex-wrap gap-1" aria-label="Filter by kind" role="group">
                {SOURCE_KINDS.filter((k) => !targetKinds || targetKinds.includes(k)).map((k) => (
                  <button key={k} type="button" aria-pressed={kinds.includes(k)} className={kinds.includes(k) ? chipOn : chipOff} onClick={() => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]))}>
                    {KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-h-72 flex-1 overflow-y-auto px-5 py-3">
              {tab === "browse" ? (
                rows.length ? (
                  <ul role="tree" aria-label="Networks" aria-multiselectable="true" onKeyDown={onTreeKey} className="text-sm">
                    {rows.map((r) => {
                      const leaves = pickableOf(r.node.source ? [r.node.source] : leavesOf(r.node));
                      const rowAccess = r.node.source && access ? access(r.node.source.ref) : undefined;
                      const state = triState(selection, leaves);
                      const focused = activeKey === r.node.id;
                      return (
                        <li
                          key={r.node.id}
                          role="treeitem"
                          data-row={r.node.id}
                          aria-level={r.depth + 1}
                          aria-expanded={r.node.source ? undefined : r.expanded}
                          aria-checked={state === "mixed" ? "mixed" : state === "checked"}
                          tabIndex={focused ? 0 : -1}
                          onFocus={() => setFocusKey(r.node.id)}
                          className="flex items-center gap-2 py-1 outline-none focus-visible:bg-signal-soft"
                          style={{ paddingLeft: `${r.depth * 1.25}rem` }}
                        >
                          {r.node.source ? (
                            <span className="w-4" />
                          ) : (
                            <button type="button" tabIndex={-1} aria-hidden="true" className="w-4 text-ink-muted" onClick={() => setExpanded((x) => { const n = new Set(x); if (n.has(r.node.id)) n.delete(r.node.id); else n.add(r.node.id); return n; })}>
                              {r.expanded ? "▾" : "▸"}
                            </button>
                          )}
                          <input
                            type="checkbox"
                            tabIndex={-1}
                            aria-label={`Select ${r.node.label}`}
                            checked={state === "checked"}
                            disabled={leaves.length === 0}
                            ref={(el) => { if (el) el.indeterminate = state === "mixed"; }}
                            onChange={() => (r.node.source ? toggle(r.node.source) : setSelection((sel) => toggleGroup(sel, leaves)))}
                          />
                          <span className={r.node.source ? (leaves.length ? "" : "opacity-50") : "font-semibold"}>{r.node.label}</span>
                          {r.node.source ? <span className="text-xs text-ink-muted">{KIND_LABEL[r.node.source.ref.kind].toLowerCase()}</span> : null}
                          {rowAccess ? <AccessBadge state={rowAccess} /> : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <Empty />
                )
              ) : flat.length ? (
                <ul aria-label={tab === "recents" ? "Recent sources" : "Favorite sources"} className="divide-y divide-rule text-sm">
                  {flat.map((s) => (
                    <li key={sourceKey(s.ref)}>
                      <label className="flex cursor-pointer items-center gap-3 py-2">
                        <input type="checkbox" disabled={!pickOk(s)} checked={isSelected(selection, s.ref)} onChange={() => toggle(s)} />
                        <span>{s.label}</span>
                        <span className="text-xs text-ink-muted">{KIND_LABEL[s.ref.kind].toLowerCase()} · {originBadge(s.ref)}</span>
                        {access ? <AccessBadge state={access(s.ref)} /> : null}
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-8 text-center text-sm text-ink-muted">{tab === "recents" ? "No recent sources yet." : "No favorites yet. Star a source to keep it here."}</p>
              )}
            </div>

            <footer className="border-t border-rule px-5 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-ink-muted">Selected ({selection.length}):</span>
                {selection.map((s) => (
                  <button key={sourceKey(s.ref)} type="button" className={chipOff} aria-label={`Remove ${s.label}`} onClick={() => toggle(s)}>
                    {s.label} <span className="text-ink-muted">{s.ref.network.startsWith("s3rch:") ? "" : s.ref.network}</span> ✕
                  </button>
                ))}
              </div>
              {target.type === "new" && selection.length > 1 ? (
                <fieldset className="mt-3 flex flex-wrap gap-4 text-sm">
                  <legend className="sr-only">Windows</legend>
                  <label className="flex items-center gap-2"><input type="radio" name="windows" checked={!merge || !mergeable} onChange={() => setMerge(false)} /> One window per source</label>
                  <label className={`flex items-center gap-2 ${mergeable ? "" : "opacity-50"}`}>
                    <input type="radio" name="windows" disabled={!mergeable} checked={merge && mergeable} onChange={() => setMerge(true)} /> Merge feeds into one window <span className="text-xs text-ink-muted">(feeds only)</span>
                  </label>
                </fieldset>
              ) : null}
              {room === 0 ? (
                <p role="status" className="mt-2 text-sm text-ink-muted">{target.type === "new" ? "This view has no room for another window." : "This window is full."}</p>
              ) : !fitsTarget ? (
                <p role="status" className="mt-2 text-sm text-ink-muted">{room === 1 ? "Only 1 more source fits." : `Only ${room} more sources fit.`}</p>
              ) : null}
              {error ? <p role="alert" className="mt-2 text-sm text-status-fail">{error}</p> : null}
              <div className="mt-3 flex justify-end gap-2">
                {props.target ? null : <button type="button" className={btnSecondary} onClick={() => setStep(1)}>Back</button>}
                <button type="button" className={btnPrimary} disabled={selection.length === 0 || !fitsTarget} onClick={confirm}>
                  {selection.length === 1 ? "Add 1 source" : `Add ${selection.length} sources`}
                </button>
              </div>
              <p aria-live="polite" className="sr-only">{selection.length === 1 ? "1 source selected" : `${selection.length} sources selected`}</p>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function StepWindow(props: { view: View; target: PickTarget; onTarget: (t: PickTarget) => void; onCancel: () => void; onNext: () => void }) {
  const { view, target, onTarget } = props;
  const isNew = target.type === "new";
  const newRoom = capacity(view, { type: "new" }) > 0;
  const usable = capacity(view, target) > 0;
  return (
    <div data-step className="px-5 py-4 text-sm">
      <p className="mb-3 text-ink-muted">Where should it go?</p>
      <label className="flex items-center gap-2 py-1">
        <input type="radio" name="where" data-autofocus disabled={!newRoom} checked={isNew && newRoom} onChange={() => onTarget({ type: "new" })} /> New window
        {newRoom ? null : <span className="text-xs text-ink-muted">(view is full)</span>}
        <select
          aria-label="Window kind"
          className="ml-2 border border-rule bg-ground px-2 py-1 text-xs"
          disabled={!isNew || !newRoom}
          value={isNew && target.kind ? target.kind : "auto"}
          onChange={(e) => onTarget(e.target.value === "auto" ? { type: "new" } : { type: "new", kind: e.target.value as SourceKind })}
        >
          <option value="auto">Kind: Auto</option>
          {SOURCE_KINDS.map((k) => <option key={k} value={k}>Kind: {KIND_LABEL[k]}</option>)}
        </select>
      </label>
      {view.windows.length ? (
        <fieldset className="mt-2">
          <legend className="py-1">Add to existing:</legend>
          {view.windows.map((w) => (
            <label key={w.id} className="flex items-center gap-2 py-1 pl-5">
              <input type="radio" name="where" disabled={!canAccept(w)} checked={target.type === "window" && target.windowId === w.id} onChange={() => onTarget({ type: "window", windowId: w.id })} />
              <span className={canAccept(w) ? "" : "opacity-50"}>{w.label ?? w.id}</span>
              <span className="text-xs text-ink-muted">{w.kind} · {w.sources.length === 1 ? "1 source" : `${w.sources.length} sources`}{canAccept(w) ? "" : " · full"}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btnSecondary} onClick={props.onCancel}>Cancel</button>
        <button type="button" className={btnPrimary} disabled={!usable} onClick={props.onNext}>Next: choose sources</button>
      </div>
    </div>
  );
}

/** An unchecked radio whose group has a checked member: Tab skips it (native radio-group behavior). */
function isSkippedRadio(el: HTMLElement): boolean {
  if (!(el instanceof HTMLInputElement) || el.type !== "radio" || el.checked || !el.name) return false;
  const group = el.form ? el.form.elements.namedItem(el.name) : null;
  const members = group instanceof RadioNodeList ? [...group] : [...document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`)];
  return members.some((m) => m instanceof HTMLInputElement && m.checked);
}

function AccessBadge({ state }: { state: AccessState }) {
  const tone = state.kind === "read" ? "text-status-pass" : state.kind === "locked" ? "text-signal" : "text-ink-muted";
  return (
    <span className={`ml-auto text-xs ${tone}`}>
      {accessLabel(state)}
      {addsAsPending(state) ? <span className="text-ink-muted"> · adds as pending</span> : null}
    </span>
  );
}

function Empty() {
  return <p className="py-8 text-center text-sm text-ink-muted">Nothing to add yet.</p>;
}

