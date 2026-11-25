"use client";

import { useEffect, useRef, useState } from "react";
import { btnSecondary, field } from "@/lib/brand-ui";
import { shortSea } from "@/lib/forum-squad";
import type { PreviewView } from "@/lib/squad-preview";

type PreviewResponse = { preview: PreviewView | null };
export function SquadPreviewPanel({ forum, taskId }: { forum: string; taskId: string }) {
  const [data, setData] = useState<PreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const lifetime = useRef<AbortController | null>(null);
  const preview = data?.preview;

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const revisionId = new URLSearchParams(window.location.search).get("previewRevision");
    void post(forum, taskId, "preview-read", revisionId, controller.signal)
      .then(response => response.json() as Promise<PreviewResponse>)
      .then(value => { if (!controller.signal.aborted) setData(value); }, () => {
        if (!controller.signal.aborted) setMessage("The preview could not be loaded.");
      });
    return () => controller.abort();
  }, [forum, taskId]);

  async function open(revisionId: string | null) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await post(forum, taskId, "preview-read", revisionId, signal);
      const value = await response.json() as PreviewResponse;
      if (!signal.aborted) setData(value);
    } catch (error) {
      if (!signal.aborted) {
        setMessage(error instanceof Error ? error.message : "The preview could not be loaded.");
        if (error instanceof PreviewRequestError && error.status === 403) setData(null);
      }
    } finally { if (!signal.aborted) setBusy(false); }
  }

  async function download() {
    const signal = lifetime.current?.signal;
    if (!preview || !signal || signal.aborted) return;
    try {
      const response = await post(forum, taskId, "preview-export", preview.selected.id, signal);
      const body = await response.blob();
      if (signal.aborted) return;
      const url = URL.createObjectURL(body), link = document.createElement("a");
      link.href = url;
      link.download = `preview-${preview.id}-${preview.selected.id}.html`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      if (!signal.aborted) setMessage(error instanceof Error ? error.message : "The download could not be opened.");
    }
  }

  const taskLink = preview ? `?task=${taskId}&previewRevision=${preview.selected.id}` : "";
  return <section className="mt-3 space-y-2 border-t border-rule pt-3">
    <h3 className="font-semibold">Partner preview</h3>
    <div className="flex flex-wrap items-center gap-2">
      {preview && <label>Preview revision <select className={field} value={preview.selected.id} disabled={busy}
        onChange={event => void open(event.currentTarget.value)}>
        {[...preview.history].reverse().map((revision, index) => <option key={revision.id} value={revision.id}>
          {preview.history.length - index} · {shortSea(revision.author)}{index === 0 ? " (current)" : ""}
        </option>)}
      </select></label>}
      <button type="button" className={btnSecondary} disabled={busy} onClick={() => void open(null)}>Refresh preview</button>
      {preview && <button type="button" className={btnSecondary} onClick={() => void download()}>Download HTML</button>}
    </div>
    {data?.preview === null && <p className="text-sm">Waiting for a preview from a delegated run.</p>}
    {preview && <>
      <p className="text-sm">Author {shortSea(preview.selected.author)} · Task owner {shortSea(preview.owner)}</p>
      {preview.newerBrief && <p className="text-sm">A newer brief revision is available.</p>}
      {preview.newerWorkbook && <p className="text-sm">A newer pricing revision is available.</p>}
      <iframe className="h-[32rem] w-full border border-rule bg-ground" title="Private partner one-pager"
        sandbox="" referrerPolicy="no-referrer" srcDoc={preview.selected.html} />
      <dl className="grid gap-2 text-sm">
        <div>
          <dt>Brief source</dt>
          <dd><a className="break-all underline" href={taskLink + "&briefRevision=" + preview.selected.inputs.brief.revisionId}>
            {preview.selected.inputs.brief.revisionId}
          </a> · {shortSea(preview.selected.inputs.brief.author)}</dd>
        </div>
        <div>
          <dt>Quote source</dt>
          <dd><a className="break-all underline" href={taskLink + "&workbookRevision=" + preview.selected.inputs.workbook.revisionId}>
            {preview.selected.inputs.workbook.sheet}!{preview.selected.inputs.workbook.cell} · {preview.selected.inputs.workbook.revisionId}
          </a> · {shortSea(preview.selected.inputs.workbook.author)}</dd>
          <dd className="text-ink-muted">Quantity {preview.selected.inputs.workbook.assumptions.quantity} · USD price{" "}
            {(preview.selected.inputs.workbook.assumptions.unitPriceCents / 100).toFixed(2)} · Discount{" "}
            {(preview.selected.inputs.workbook.assumptions.discountBps / 100).toFixed(2)}%</dd>
        </div>
      </dl>
      {preview.selected.sources.length > 0 && <ul className="text-sm">{preview.selected.sources.map(url =>
        <li key={url}><a className="break-all underline" href={url} rel="noreferrer">{url}</a></li>)}</ul>}
    </>}
    <p role="status" className="text-sm">{busy ? "Opening preview…" : message}</p>
  </section>;
}

class PreviewRequestError extends Error {
  constructor(readonly status: number) {
    super(status === 403 ? "Your session cannot access this preview."
      : status === 404 ? "That preview revision could not be opened." : "The preview request could not be confirmed.");
  }
}
async function post(forum: string, taskId: string, action: string, revisionId: string | null, signal: AbortSignal) {
  const response = await fetch("/api/squad/pilot/project", { method: "POST", cache: "no-store", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ forum, taskId, action, revisionId }),
  });
  if (!response.ok) throw new PreviewRequestError(response.status);
  return response;
}
