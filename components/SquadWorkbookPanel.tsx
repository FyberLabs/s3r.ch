"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { btnSecondary, field } from "@/lib/brand-ui";
import { shortSea } from "@/lib/forum-squad";
import { parsePricingInputs, pricingAnchor, pricingTotalCents, type PricingInputs } from "@/lib/workbook-pricing";
import type { WorkbookView } from "@/lib/squad-workbook";

type WorkbookResponse = { workbook: WorkbookView | null; canRevise: boolean; canReview: boolean };
type Fields = { quantity: string; unitPrice: string; discount: string };
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const toFields = (inputs: PricingInputs): Fields => ({ quantity: String(inputs.quantity),
  unitPrice: (inputs.unitPriceCents / 100).toFixed(2), discount: (inputs.discountBps / 100).toFixed(2) });

function hundredths(value: string) {
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) return Number.NaN;
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export function SquadWorkbookPanel({ forum, taskId }: { forum: string; taskId: string }) {
  const [view, setView] = useState<WorkbookResponse | null>(null);
  const [draft, setDraft] = useState<Fields>({ quantity: "", unitPrice: "", discount: "" });
  const [range, setRange] = useState("B5");
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const pending = useRef<{ key: string; id: string } | null>(null);

  function apply(value: WorkbookResponse) {
    setView(value);
    if (value.workbook) setDraft(toFields(value.workbook.selected.inputs));
  }

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const revisionId = new URLSearchParams(window.location.search).get("workbookRevision");
    void post(forum, taskId, { action: "workbook-read", revisionId }, controller.signal)
      .then(response => response.json() as Promise<WorkbookResponse>)
      .then(result => { if (!controller.signal.aborted) apply(result); }, () => {
        if (!controller.signal.aborted) setMessage("The workbook could not be loaded.");
      });
    return () => controller.abort();
  }, [forum, taskId]);

  async function send(body: object, after?: () => void) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await post(forum, taskId, body, signal);
      const result = await response.json() as WorkbookResponse;
      if (!signal.aborted) { apply(result); after?.(); }
    } catch (error) {
      if (!signal.aborted) {
        setMessage(error instanceof Error ? error.message : "The workbook could not be updated.");
        if (error instanceof WorkbookRequestError && error.status === 403) setView(null);
      }
    } finally { if (!signal.aborted) setBusy(false); }
  }

  function operationId(body: object) {
    const key = JSON.stringify(body);
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
    return pending.current.id;
  }

  const workbook = view?.workbook;
  const canEdit = !!workbook && view?.canRevise && workbook.selected.id === workbook.current;
  const inputs = parsePricingInputs({ quantity: /^\d{1,6}$/.test(draft.quantity) ? Number(draft.quantity) : Number.NaN,
    unitPriceCents: hundredths(draft.unitPrice), discountBps: hundredths(draft.discount) });
  const total = canEdit ? (inputs ? pricingTotalCents(inputs) : undefined) : workbook?.totalCents;

  function save(event: FormEvent) {
    event.preventDefault();
    if (!workbook || !canEdit || !inputs) return;
    const body = { action: "workbook-revise", base: workbook.selected.id, inputs };
    void send({ ...body, revisionId: operationId(body) }, () => {
      pending.current = null;
      setMessage("Pricing revision saved.");
    });
  }
  function comment(event: FormEvent) {
    event.preventDefault();
    if (!workbook || !view?.canReview) return;
    const anchor = pricingAnchor(range.trim().toUpperCase());
    if (!anchor) { setMessage("Enter a cell or range on the Pricing sheet, such as B4 or B2:B5."); return; }
    const body = { action: "workbook-comment", revisionId: workbook.selected.id, sheet: workbook.sheet, range: anchor, text: text.trim() };
    void send({ ...body, id: operationId(body) }, () => { pending.current = null; setText(""); });
  }
  async function download() {
    const signal = lifetime.current?.signal;
    if (!workbook || !signal || signal.aborted) return;
    try {
      const response = await post(forum, taskId, { action: "workbook-export", revisionId: workbook.selected.id }, signal);
      const blob = await response.blob();
      if (signal.aborted) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url;
      link.download = `pricing-${workbook.id}-${workbook.selected.id}.xlsx`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      if (!signal.aborted) setMessage(error instanceof Error ? error.message : "The download could not be opened.");
    }
  }

  return <section className="mt-3 space-y-2 border-t border-rule pt-3">
    <h3 className="font-semibold">Pricing workbook</h3>
    <div className="flex flex-wrap items-center gap-2">
      {workbook && <label>Pricing revision <select className={field} value={workbook.selected.id} disabled={busy}
        onChange={event => void send({ action: "workbook-read", revisionId: event.currentTarget.value })}>
        {[...workbook.history].reverse().map((revision, index) => <option key={revision.id} value={revision.id}>
          {workbook.history.length - index} · {shortSea(revision.author)}{index === 0 ? " (current)" : ""}
        </option>)}
      </select></label>}
      <button type="button" className={btnSecondary} disabled={busy}
        onClick={() => void send({ action: "workbook-read", revisionId: null })}>Refresh pricing</button>
      {workbook && <button type="button" className={btnSecondary} onClick={() => void download()}>Download XLSX</button>}
    </div>
    {view?.workbook === null && <p className="text-sm">Waiting for a workbook from the delegated run.</p>}
    {workbook && <>
      <form className="space-y-2" onSubmit={save}>
        <table className="w-full text-sm">
          <thead><tr className="text-left"><th scope="col">{workbook.sheet}</th><th scope="col">Value</th></tr></thead>
          <tbody>
            {([["B2", "Quantity", "quantity"], ["B3", "Unit price (USD)", "unitPrice"], ["B4", "Discount (%)", "discount"]] as const)
              .map(([cell, label, key]) => <tr key={cell} className="border-t border-rule">
                <th scope="row" className="py-2 text-left font-normal"><label htmlFor={key + taskId}>{cell} · {label}</label></th>
                <td><input id={key + taskId} className={`${field} w-full`} value={draft[key]} readOnly={!canEdit}
                  inputMode={key === "quantity" ? "numeric" : "decimal"} maxLength={12}
                  onChange={event => setDraft(current => ({ ...current, [key]: event.target.value }))} /></td>
              </tr>)}
            <tr className="border-t border-rule"><th scope="row" className="py-2 text-left">B5 · Quote total</th>
              <td><output aria-live="polite">{total === undefined ? "Check inputs" : currency.format(total / 100)}</output></td></tr>
          </tbody>
        </table>
        <p className="break-all text-sm"><code>={workbook.selected.formula}</code></p>
        {canEdit && <button type="submit" className={btnSecondary} disabled={busy || !inputs ||
          JSON.stringify(inputs) === JSON.stringify(workbook.selected.inputs)}>Save pricing revision</button>}
      </form>
      {workbook.selected.sources.length > 0 && <ul className="text-sm">{workbook.selected.sources.map(url =>
        <li key={url}><a className="break-all underline" href={url} rel="noreferrer">{url}</a></li>)}</ul>}
      <ul className="space-y-1 text-sm">{workbook.comments.map(note => <li key={note.id}>
        {note.sheet}!{note.range} · {shortSea(note.author)} <p className="whitespace-pre-wrap">{note.text}</p>
      </li>)}</ul>
      {view?.canReview && <form className="grid gap-2" onSubmit={comment}>
        <label>Cell or range <input className={field} value={range} maxLength={5} required onChange={event => setRange(event.currentTarget.value)} /></label>
        <label>Pricing comment <textarea className={field} value={text} maxLength={1000} required onChange={event => setText(event.currentTarget.value)} /></label>
        <button type="submit" className={btnSecondary} disabled={busy}>Add pricing comment</button>
      </form>}
    </>}
    <p role="status" className="text-sm">{busy ? "Updating workbook…" : message}</p>
  </section>;
}

class WorkbookRequestError extends Error {
  constructor(readonly status: number) {
    super(status === 409 ? "Pricing has changed. Refresh the current revision."
      : status === 403 ? "Your session cannot access this workbook."
      : status === 400 ? "Check the pricing inputs or the selected cell range."
      : "The workbook request could not be confirmed.");
  }
}
async function post(forum: string, taskId: string, body: object, signal: AbortSignal) {
  const response = await fetch("/api/squad/pilot/project", { method: "POST", cache: "no-store", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ forum, taskId, ...body }),
  });
  if (!response.ok) throw new WorkbookRequestError(response.status);
  return response;
}
