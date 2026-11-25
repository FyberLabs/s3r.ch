"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { btnSecondary, field } from "@/lib/brand-ui";
import { shortSea } from "@/lib/forum-squad";
import type { BriefAnnotation, BriefView } from "@/lib/squad-brief";

type BriefResponse = { brief: BriefView | null; canRevise: boolean; canReview: boolean };
const endpoint = "/api/squad/pilot/project";
const reviewNames = { comment: "Comment", approve: "Approve draft", "request-changes": "Request changes" } as const;

export function SquadBriefPanel({ forum, taskId }: { forum: string; taskId: string }) {
  const [view, setView] = useState<BriefResponse | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [kind, setKind] = useState<BriefAnnotation["kind"]>("comment");
  const [text, setText] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const mutation = useRef<{ key: string; id: string } | null>(null);

  function apply(value: BriefResponse) {
    setView(value);
    setMarkdown(value.brief?.selected.markdown ?? "");
  }

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void post(forum, taskId, { action: "brief-read", revisionId: null }, controller.signal)
      .then(response => response.json() as Promise<BriefResponse>)
      .then(value => { if (!controller.signal.aborted) apply(value); }, () => {
        if (!controller.signal.aborted) setMessage("The brief could not be loaded.");
      });
    return () => controller.abort();
  }, [forum, taskId]);

  async function select(body: object, after?: () => void) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await post(forum, taskId, body, signal);
      const value: BriefResponse = await response.json();
      if (!signal.aborted) { apply(value); after?.(); }
    } catch (error) {
      if (!signal.aborted) {
        setMessage(error instanceof Error ? error.message : "The brief could not be updated.");
        if (error instanceof BriefRequestError && error.status === 403) {
          setView(null);
          setMarkdown("");
        }
      }
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  function operationId(fields: object) {
    const key = JSON.stringify(fields);
    if (mutation.current?.key !== key) mutation.current = { key, id: crypto.randomUUID() };
    return mutation.current.id;
  }
  const brief = view?.brief;
  const current = brief && brief.selected.id === brief.current;
  const canEdit = current && view?.canRevise;

  function save(event: FormEvent) {
    event.preventDefault();
    if (!brief || !canEdit) return;
    const fields = { action: "brief-revise", base: brief.selected.id, markdown };
    void select({ ...fields, revisionId: operationId(fields) }, () => {
      mutation.current = null;
      setMessage("Revision saved.");
    });
  }

  function review(event: FormEvent) {
    event.preventDefault();
    if (!brief || !view?.canReview) return;
    if (Boolean(start) !== Boolean(end)) { setMessage("Enter both line numbers."); return; }
    const fields = { action: "brief-review", revisionId: brief.selected.id, kind, text: text.trim(),
      lines: start ? [Number(start), Number(end)] : null };
    void select({ ...fields, id: operationId(fields) }, () => {
      mutation.current = null;
      setText("");
      setStart("");
      setEnd("");
    });
  }

  async function download() {
    const signal = lifetime.current?.signal;
    if (!brief || !signal || signal.aborted) return;
    setMessage("");
    try {
      const response = await post(forum, taskId, { action: "brief-export", revisionId: brief.selected.id }, signal);
      const blob = await response.blob();
      if (signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `brief-${brief.id}-${brief.selected.id}.md`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      if (!signal.aborted) setMessage(error instanceof Error ? error.message : "The download could not be opened.");
    }
  }

  return <section className="mt-3 space-y-2 border-t border-rule pt-3">
    <h3 className="font-semibold">Partner brief</h3>
    {!brief && <div className="flex flex-wrap items-center gap-2">
      {view?.brief === null && <p className="text-sm">Waiting for a draft from the delegated run.</p>}
      <button type="button" className={btnSecondary} disabled={busy}
        onClick={() => void select({ action: "brief-read", revisionId: null })}>Refresh brief</button>
    </div>}
    {brief && <>
      <div className="flex flex-wrap items-center gap-2">
        <label>Revision <select className={field} disabled={busy} value={brief.selected.id}
          onChange={event => void select({ action: "brief-read", revisionId: event.currentTarget.value })}>
          {[...brief.history].reverse().map((revision, index) =>
            <option value={revision.id} key={revision.id}>{brief.history.length - index} · {shortSea(revision.author)}{index === 0 ? " (current)" : ""}</option>)}
        </select></label>
        <button type="button" className={btnSecondary} disabled={busy}
          onClick={() => void select({ action: "brief-read", revisionId: null })}>Refresh brief</button>
        <button type="button" className={btnSecondary} onClick={() => void download()}>Download Markdown</button>
      </div>
      {brief.selected.run && <p className="break-all text-sm">Plane delivery <code>{brief.selected.run.deliveryId}</code></p>}
      {brief.selected.sources.length > 0 && <ul className="text-sm">{brief.selected.sources.map(url =>
        <li key={url}><a className="break-all underline" href={url} rel="noreferrer">{url}</a></li>)}</ul>}
      {canEdit ? <form className="grid gap-2" onSubmit={save}>
        <label>Brief Markdown <textarea className={`${field} block w-full font-mono`} rows={10} required
          value={markdown} onChange={event => setMarkdown(event.currentTarget.value)} /></label>
        <button className={btnSecondary} disabled={busy || markdown === brief.selected.markdown}>Save revision</button>
      </form> : <pre className="whitespace-pre-wrap break-words text-sm">{brief.selected.markdown}</pre>}
      {brief.annotations.length > 0 && <ul className="space-y-1 text-sm">{brief.annotations.map(note => <li key={note.id}>
        {reviewNames[note.kind]} · {shortSea(note.author)}
        {note.lines && ` · Lines ${note.lines[0]}–${note.lines[1]}`}
        {note.text && <p className="whitespace-pre-wrap">{note.text}</p>}
      </li>)}</ul>}
      {view?.canReview && <form className="grid gap-2" onSubmit={review}>
        <label>Review <select className={field} value={kind}
          onChange={event => setKind(event.currentTarget.value as BriefAnnotation["kind"])}>
          {Object.entries(reviewNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
        </select></label>
        <label>Feedback <textarea className={field} value={text} maxLength={1000} required={kind !== "approve"}
          onChange={event => setText(event.currentTarget.value)} /></label>
        <div className="flex flex-wrap gap-2">
          <label>First line <input type="number" min="1" className={field} value={start} onChange={event => setStart(event.currentTarget.value)} /></label>
          <label>Last line <input type="number" min="1" className={field} value={end} onChange={event => setEnd(event.currentTarget.value)} /></label>
        </div>
        <button className={btnSecondary} disabled={busy}>Record review</button>
      </form>}
    </>}
    <p role="status" className="text-sm">{busy ? "Updating brief…" : message}</p>
  </section>;
}

class BriefRequestError extends Error {
  constructor(readonly status: number) {
    super(status === 409 ? "The brief changed. Refresh to see the latest revision."
      : status === 403 ? "Your session cannot access the brief."
      : status === 400 ? "Check the Markdown or the selected line range."
      : "The brief request could not be confirmed.");
  }
}
async function post(forum: string, taskId: string, body: object, signal: AbortSignal) {
  const response = await fetch(endpoint, { method: "POST", cache: "no-store", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ forum, taskId, ...body }),
  });
  if (!response.ok) throw new BriefRequestError(response.status);
  return response;
}
