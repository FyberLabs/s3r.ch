"use client";

/**
 * A View on screen (docs/views.md §6): its windows in the saved split layout, with an unread
 * badge per window and focus. `F` maximizes the focused window and `Esc` restores it;
 * `Alt+1..9` moves focus to window N. A View with no windows shows the empty "+" slot.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { btnSecondary } from "@/lib/brand-ui";
import type { AccessState } from "@/lib/views-access";
import type { ObservedRow } from "@/lib/views-decorators";
import { keyAction, leafOrder, markSeen, resizeSplit, unreadCount, type SeenTimes } from "@/lib/views-layout";
import type { SourceRef } from "@/lib/views-source-ref";
import type { LayoutTree, View } from "@/lib/views-window";
import { ViewsLayout } from "./ViewsLayout";
import { ViewsWindow } from "./ViewsWindow";

export type ViewsScreenProps = {
  view: View;
  rows: ObservedRow[];
  access: (ref: SourceRef) => AccessState;
  label: (ref: SourceRef) => string;
  /** Last-seen times by window id, and where to keep them. */
  seen: SeenTimes;
  onSeen: (seen: SeenTimes) => void;
  /** Current time in Unix seconds (the same clock as `observedAt`). */
  now: () => number;
  /** Save a resized layout. Without it the layout cannot be resized. */
  onLayout?: (layout: LayoutTree) => void;
  /** Open the picker for a new window. */
  onAdd?: () => void;
  onSend?: (windowId: string, target: SourceRef, text: string) => void;
};

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function ViewsScreen(props: ViewsScreenProps) {
  const { view, seen, onSeen, now } = props;
  const [layout, setLayout] = useState<LayoutTree | null>(view.layout);
  const [focused, setFocused] = useState<string | null>(null);
  const [maximized, setMaximized] = useState<string | null>(null);
  const leaves = useRef(new Map<string, HTMLElement>());
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // A saved or reloaded View replaces the local layout.
  useEffect(() => setLayout(view.layout), [view.layout]);

  const order = useMemo(() => leafOrder(layout), [layout]);
  const byId = useMemo(() => new Map(view.windows.map((w) => [w.id, w])), [view.windows]);
  const shown = maximized && byId.has(maximized) ? maximized : null;

  const focus = useCallback(
    (id: string) => {
      if (id === focused) return;
      // Leaving a window and entering one both count as seeing them now.
      onSeen(markSeen(seen, focused ? [focused, id] : [id], now()));
      setFocused(id);
    },
    [focused, seen, onSeen, now],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || (e.target instanceof Element && e.target.closest("[role=dialog]"))) return;
      const action = keyAction(
        { key: e.key, code: e.code, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, editable: isEditable(e.target) },
        order,
        focused,
        shown,
      );
      if (!action) return;
      e.preventDefault();
      if (action.type === "restore") {
        setMaximized(null);
      } else if (action.type === "maximize") {
        setMaximized(action.windowId);
      } else {
        // Moving focus while maximized maximizes the newly focused window.
        if (shown) setMaximized(action.windowId);
        leaves.current.get(action.windowId)?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [order, focused, shown]);

  // Keep keyboard focus on the window that was maximized or restored.
  useEffect(() => {
    if (focused && !leaves.current.get(focused)?.contains(document.activeElement)) leaves.current.get(focused)?.focus();
  }, [shown, focused]);

  const onResize = props.onLayout
    ? (path: number[], index: number, delta: number, done: boolean) => {
        const current = layoutRef.current;
        if (!current) return;
        const next = delta ? resizeSplit(current, path, index, delta) : current;
        if (next !== current) setLayout(next);
        layoutRef.current = next;
        if (done) props.onLayout!(next);
      }
    : undefined;

  if (!layout || view.windows.length === 0) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center border border-dashed border-rule">
        {props.onAdd ? (
          <button type="button" className={btnSecondary} onClick={props.onAdd}>
            + Add a window
          </button>
        ) : (
          <p className="text-ink-muted">This View has no windows.</p>
        )}
      </div>
    );
  }

  const leaf = (id: string) => {
    const w = byId.get(id);
    if (!w) return null;
    const isMax = shown === id;
    const hidden = !!shown && !isMax;
    return (
      <div
        ref={(el) => {
          if (el) leaves.current.set(id, el);
          else leaves.current.delete(id);
        }}
        tabIndex={-1}
        data-window-id={id}
        inert={hidden}
        aria-hidden={hidden || undefined}
        className={`flex min-h-0 min-w-0 flex-1 outline-none ${focused === id ? "ring-1 ring-signal" : ""} ${isMax ? "absolute inset-0 z-10 bg-panel" : ""}`}
        onFocusCapture={() => focus(id)}
        onPointerDownCapture={() => focus(id)}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col [&>section]:flex-1">
          <ViewsWindow
            window={w}
            rows={props.rows}
            label={props.label}
            access={props.access}
            unread={focused === id ? 0 : unreadCount(w, props.rows, props.access, seen[id])}
            onSend={props.onSend ? (t, text) => props.onSend!(id, t, text) : undefined}
            actions={
              <button
                type="button"
                className="px-1 text-xs text-ink-muted hover:text-ink"
                aria-pressed={isMax}
                title={isMax ? "Restore (Esc)" : "Maximize (F)"}
                onClick={() => {
                  focus(id);
                  setMaximized(isMax ? null : id);
                }}
              >
                {isMax ? "Restore" : "Maximize"}
              </button>
            }
          />
        </div>
      </div>
    );
  };

  return (
    <div className="relative flex min-h-[70vh] flex-1">
      <ViewsLayout tree={layout} leaf={leaf} onResize={onResize} />
    </div>
  );
}
