"use client";

/**
 * One View window (docs/views.md §3.1, §3.5, §4): header with the window title and source
 * chips (color, label, origin badge), rows, per-source access notices, and the targeted
 * composer. Merged feed windows interleave sources with a chip on every row; tabbed windows
 * show one source at a time.
 */
import { useId, useState } from "react";
import { btnPrimary, field } from "@/lib/brand-ui";
import type { AccessState } from "@/lib/views-access";
import type { ViewRow } from "@/lib/views-adapters";
import { checkSend, chooseTarget, composerTargets } from "@/lib/views-composer";
import { mergeFeedRows, originBadge, sourceColor, windowTitle, type ObservedRow, type SourceColor } from "@/lib/views-decorators";
import { formatCanonical, sameSource, type SourceRef } from "@/lib/views-source-ref";
import type { ViewWindow as Win } from "@/lib/views-window";
import { ViewsWindowStatus } from "./ViewsWindowStatus";

/** Static class names so the palette is part of the build; never stored CSS. */
const SWATCH: Record<SourceColor, string> = {
  amber: "bg-amber-400",
  teal: "bg-teal-400",
  violet: "bg-violet-400",
  rose: "bg-rose-400",
  lime: "bg-lime-400",
  sky: "bg-sky-400",
  orange: "bg-orange-400",
  slate: "bg-slate-400",
};

export function SourceChip(props: { window: Win; source: SourceRef; label: string; onRemove?: () => void }) {
  const color = sourceColor(props.window, props.source);
  return (
    <span className="inline-flex items-center gap-1.5 border border-rule bg-panel px-2 py-0.5 text-xs">
      <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${SWATCH[color]}`} />
      <span className="font-semibold">{props.label}</span>
      <span className="text-ink-muted">{originBadge(props.source)}</span>
      {props.onRemove ? (
        <button type="button" aria-label={`Remove ${props.label}`} className="text-ink-muted hover:text-ink" onClick={props.onRemove}>
          ✕
        </button>
      ) : null}
    </span>
  );
}

export type ViewsWindowProps = {
  window: Win;
  rows: ObservedRow[];
  label: (ref: SourceRef) => string;
  access: (ref: SourceRef) => AccessState;
  declined?: (ref: SourceRef) => boolean;
  /** Last source the user posted to in this window, for the composer default. */
  lastTarget?: SourceRef;
  onRemoveSource?: (ref: SourceRef) => void;
  onSend?: (target: SourceRef, text: string) => void;
};

export function ViewsWindow(props: ViewsWindowProps) {
  const { window: w, label, access } = props;
  const [tab, setTab] = useState(0);
  const [replyTo, setReplyTo] = useState<SourceRef | undefined>();
  const titleId = useId();
  const active = w.mode === "tabs" ? w.sources[Math.min(tab, w.sources.length - 1)]! : undefined;
  const shown = w.mode === "merged" ? mergeFeedRows(props.rows) : props.rows.filter((r) => !active || sameSource(r.row.source, active)).map((r) => r.row).sort((a, b) => b.ts - a.ts);
  const removable = w.mode === "merged" && w.sources.length > 2 && props.onRemoveSource;
  return (
    <section aria-labelledby={titleId} className="flex min-h-0 flex-col border border-rule bg-panel">
      <header className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2">
        <h3 id={titleId} className="text-sm font-semibold">
          {windowTitle(w, label)}
        </h3>
        {w.mode === "tabs" ? (
          <div role="tablist" aria-label="Sources" className="flex flex-wrap gap-1">
            {w.sources.map((s, i) => (
              <button key={formatCanonical(s)} type="button" role="tab" aria-selected={i === tab} className={i === tab ? "outline outline-1 outline-signal" : ""} onClick={() => setTab(i)}>
                <SourceChip window={w} source={s} label={label(s)} />
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {w.sources.map((s) => (
              <SourceChip key={formatCanonical(s)} window={w} source={s} label={label(s)} onRemove={removable ? () => props.onRemoveSource!(s) : undefined} />
            ))}
          </div>
        )}
      </header>
      <div className="px-3 pt-2">
        <ViewsWindowStatus window={w} access={access} declined={props.declined} label={label} />
      </div>
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2 text-sm">
        {shown.map((r) => (
          <Row key={r.key} row={r} window={w} label={label} chip={w.mode !== "single"} onReply={props.onSend ? () => setReplyTo(r.source) : undefined} />
        ))}
      </ol>
      {props.onSend ? <Composer window={w} access={access} label={label} replyTo={replyTo} lastTarget={props.lastTarget} onCancelReply={() => setReplyTo(undefined)} onSend={(t, text) => { setReplyTo(undefined); props.onSend!(t, text); }} /> : null}
    </section>
  );
}

function Row(props: { row: ViewRow; window: Win; label: (ref: SourceRef) => string; chip: boolean; onReply?: () => void }) {
  const { row } = props;
  return (
    <li className="group">
      <div className="flex items-baseline gap-2">
        {props.chip ? <SourceChip window={props.window} source={row.source} label={props.label(row.source)} /> : null}
        <span className="font-mono text-xs text-ink-muted">{row.author}</span>
        {props.onReply ? (
          <button type="button" className="ml-auto text-xs text-ink-muted opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={props.onReply}>
            Reply
          </button>
        ) : null}
      </div>
      <p className="mt-0.5">{row.body}</p>
    </li>
  );
}

function Composer(props: {
  window: Win;
  access: (ref: SourceRef) => AccessState;
  label: (ref: SourceRef) => string;
  replyTo?: SourceRef;
  lastTarget?: SourceRef;
  onCancelReply: () => void;
  onSend: (target: SourceRef, text: string) => void;
}) {
  const targets = composerTargets(props.window, props.access);
  const [picked, setPicked] = useState<SourceRef | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  if (targets.length === 0) return null;
  // A reply targets the replied message's source; otherwise the user's pick, the last target, or the first.
  const fallback = chooseTarget(targets, { replyTo: props.replyTo, last: props.lastTarget });
  const target = props.replyTo ? fallback : picked && targets.some((t) => sameSource(t, picked)) ? picked : fallback;
  function send() {
    const r = checkSend(targets, target, text);
    if (!r.ok) return setError(r.error);
    setError(null);
    setText("");
    props.onSend(r.target, r.text);
  }
  return (
    <form className="border-t border-rule px-3 py-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
      {targets.length > 1 || props.window.mode === "tabs" ? (
        <fieldset className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <legend className="sr-only">Post to</legend>
          <span className="text-ink-muted">Post to</span>
          {targets.map((t) => (
            <label key={formatCanonical(t)} className="flex items-center gap-1">
              <input type="radio" name={`${inputId}-target`} checked={!!target && sameSource(t, target)} onChange={() => setPicked(t)} disabled={!!props.replyTo} />
              <SourceChip window={props.window} source={t} label={props.label(t)} />
            </label>
          ))}
        </fieldset>
      ) : null}
      {props.replyTo ? (
        <p className="mb-2 flex items-center gap-2 text-xs text-ink-muted">
          {target ? <>Replying in {props.label(props.replyTo)}</> : <span role="alert" className="text-status-fail">You can't post to {props.label(props.replyTo)}.</span>}
          <button type="button" className="underline" onClick={props.onCancelReply}>Cancel reply</button>
        </p>
      ) : null}
      <div className="flex gap-2">
        <label htmlFor={inputId} className="sr-only">Message</label>
        <input id={inputId} className={`${field} flex-1`} value={text} onChange={(e) => setText(e.target.value)} placeholder={target ? `Message ${props.label(target)}…` : "Choose where to post"} />
        <button type="submit" className={btnPrimary} disabled={!target}>
          Send
        </button>
      </div>
      {error ? <p role="alert" className="mt-1 text-xs text-status-fail">{error}</p> : null}
    </form>
  );
}
