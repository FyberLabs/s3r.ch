import type { ReactNode } from "react";

export const postCardClassName = "block border border-rule bg-panel p-5";

/** Shared presentation only; callers retain their own authorization and delivery. */
export function PostContent({ title, kind, body, tags = [], when, tagsLabel, children }: {
  title: string; kind: string; body?: string; tags?: readonly string[];
  when?: string | null; tagsLabel?: string; children?: ReactNode;
}) {
  return <>
    <div className="flex items-start justify-between gap-3">
      <h2 className="break-words text-base font-semibold text-ink">{title}</h2>
      <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-signal">{kind}</span>
    </div>
    {body !== undefined && <p className="mt-1 text-sm text-ink-muted">{body}</p>}
    {children}
    {(tags.length > 0 || when) && <p aria-label={tagsLabel} className="mt-2 text-xs text-ink-muted">
      {tags.join(" · ")}{when ? `${tags.length ? " · " : ""}${when}` : ""}
    </p>}
  </>;
}
