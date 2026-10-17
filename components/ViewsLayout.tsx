"use client";

/**
 * Resizable split layout for a View (docs/views.md §6). Splits lay their children out in a
 * row or column by share; the border between two children is a separator that can be
 * dragged or moved with the arrow keys.
 */
import { Fragment, useRef, type ReactNode } from "react";
import type { LayoutTree } from "@/lib/views-window";

/** Share moved per arrow key press. */
export const KEY_STEP = 0.05;

export type ResizeHandler = (path: number[], index: number, delta: number, done: boolean) => void;

/** Without `onResize` (or while a window is maximized) the borders are plain lines, not controls. */
export function ViewsLayout(props: { tree: LayoutTree; leaf: (windowId: string) => ReactNode; onResize?: ResizeHandler }) {
  return <Node node={props.tree} path={[]} leaf={props.leaf} onResize={props.onResize} />;
}

function Node(props: { node: LayoutTree; path: number[]; leaf: (windowId: string) => ReactNode; onResize?: ResizeHandler }) {
  const { node } = props;
  if (node.type === "leaf") return <>{props.leaf(node.windowId)}</>;
  const row = node.dir === "row";
  return (
    <div className={`flex min-h-0 min-w-0 flex-1 ${row ? "flex-row" : "flex-col"}`}>
      {node.children.map((child, i) => (
        <Fragment key={child.type === "leaf" ? child.windowId : `split-${i}`}>
          {i > 0 ? <Separator row={row} share={node.sizes[i - 1]!} path={props.path} index={i - 1} onResize={props.onResize} /> : null}
          <div className="flex min-h-0 min-w-0" style={{ flexGrow: node.sizes[i], flexBasis: 0 }}>
            <Node node={child} path={[...props.path, i]} leaf={props.leaf} onResize={props.onResize} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function Separator(props: { row: boolean; share: number; path: number[]; index: number; onResize?: ResizeHandler }) {
  const last = useRef<number | null>(null);
  const { row, onResize } = props;
  if (!onResize) return <div aria-hidden="true" className={row ? "w-1" : "h-1"} />;
  const span = (el: HTMLElement) => {
    const rect = el.parentElement?.getBoundingClientRect();
    return rect ? (row ? rect.width : rect.height) : 0;
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label="Resize windows"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(props.share * 100)}
      className={`shrink-0 touch-none bg-rule hover:bg-signal focus-visible:bg-signal ${row ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        last.current = row ? e.clientX : e.clientY;
      }}
      onPointerMove={(e) => {
        if (last.current === null) return;
        const pos = row ? e.clientX : e.clientY;
        const total = span(e.currentTarget);
        if (total > 0 && pos !== last.current) onResize(props.path, props.index, (pos - last.current) / total, false);
        last.current = pos;
      }}
      onPointerUp={() => {
        if (last.current === null) return;
        last.current = null;
        onResize(props.path, props.index, 0, true);
      }}
      onPointerCancel={() => {
        if (last.current === null) return;
        last.current = null;
        onResize(props.path, props.index, 0, true);
      }}
      onKeyDown={(e) => {
        const back = row ? "ArrowLeft" : "ArrowUp";
        const fwd = row ? "ArrowRight" : "ArrowDown";
        if (e.key !== back && e.key !== fwd) return;
        e.preventDefault();
        onResize(props.path, props.index, e.key === fwd ? KEY_STEP : -KEY_STEP, true);
      }}
    />
  );
}
