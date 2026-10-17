"use client";

/**
 * Per-source access notice inside a View window (docs/views.md §3.7). A source that cannot be
 * read keeps its slot and says why: waiting for access, request declined, access removed,
 * sign in required, or needs connection.
 */
import { sourceStatus, statusLabel, type AccessState } from "@/lib/views-access";
import { formatCanonical, type SourceRef } from "@/lib/views-source-ref";
import type { ViewWindow } from "@/lib/views-window";

export function ViewsWindowStatus(props: {
  window: ViewWindow;
  access: (ref: SourceRef) => AccessState;
  /** Sources whose access request was declined (from the request status, a later item). */
  declined?: (ref: SourceRef) => boolean;
  label: (ref: SourceRef) => string;
}) {
  const rows = props.window.sources
    .map((ref) => ({ ref, status: sourceStatus(props.window, ref, props.access(ref), props.declined?.(ref) ?? false) }))
    .filter((r) => r.status !== "ready");
  if (!rows.length) return null;
  return (
    <ul role="status" className="space-y-1 text-sm">
      {rows.map(({ ref, status }) => (
        <li key={formatCanonical(ref)} className={`border px-3 py-2 ${status === "removed" || status === "declined" ? "border-status-fail" : "border-rule"}`}>
          <span className="font-semibold">{props.label(ref)}</span> <span className="text-ink-muted">· {statusLabel(status)}</span>
        </li>
      ))}
    </ul>
  );
}
