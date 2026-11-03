"use client";
import { useEffect, useRef, useState } from "react";
import { useSquadDelegation } from "./SquadDelegationProvider";
import type { AssignmentClient, AssignmentScope, AssignmentView } from "@/lib/assignment-client";
import { isSeaPubkey } from "@/lib/identity/forum-check";
/** Controls use the provisioned authenticated assignment service. Descriptive
 * status never becomes assignment or ACL authority. Default source is absent. */
export function SquadDelegationControls({ scope, client: supplied }: { scope?: AssignmentScope; client?: AssignmentClient } = {}) {
  const context = useSquadDelegation(), client = supplied ?? context;
  const [view, setView] = useState<AssignmentView | null>(null), [target, setTarget] = useState("");
  const [confirmedOperation, setConfirmedOperation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const epoch = useRef(0);
  const forum = scope?.forum, owner = scope?.owner;
  useEffect(() => {
    const token = ++epoch.current; setView(null); setTarget(""); setNotice(""); setConfirmedOperation(null); setBusy(false);
    if (!client || !forum || !owner) return;
    let active = true, loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try { const result = await client.read({ forum, owner });
        if (active && token === epoch.current && result.forum === forum && result.owner === owner) setView(result);
      } catch { if (active && token === epoch.current) { setView(null); setNotice("Assignment evidence is unavailable. Reload to retry."); } }
      finally { loading = false; }
    };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 1500);
    return () => { active = false; epoch.current++; clearInterval(timer); };
  }, [client, forum, owner]);
  const pending = view?.operation && ["cancellations", "replacement"].includes(view.operation.phase) ? view.operation : null;
  async function act(action: "start" | "resume" | "abort") {
    if (!client || !forum || !owner || !view || busy) return;
    const token = epoch.current; setBusy(true); setNotice(""); setConfirmedOperation(null);
    try {
      if (action === "abort") { if (!pending) return; await client.abort({ forum, owner }, pending.id);
        if (token === epoch.current) setNotice("Change canceled. Existing access cancellations remain in effect."); }
      else {
        const result = action === "resume" && pending
          ? await client.resume({ forum, owner }, pending.id, pending.replacement)
          : await client.start({ forum, owner }, crypto.randomUUID().replaceAll("-", ""), target.trim(), view.revision);
        if (token !== epoch.current) return;
        if (result.status === "complete") setConfirmedOperation(result.receipt.operationId);
        // Pending comes from the polled durable operation, so another client
        // completing it cannot leave a stale local pending message behind.
      }
      const current = await client.read({ forum, owner });
      if (token === epoch.current && current.forum === forum && current.owner === owner) setView(current);
    } catch (error) {
      if (token === epoch.current) {
        setNotice(error instanceof Error ? error.message : "Request interrupted. Reload to recover the saved operation.");
        try { const current = await client.read({ forum, owner }); if (token === epoch.current && current.forum === forum && current.owner === owner) setView(current); }
        catch { if (token === epoch.current) setView(null); }
      }
    } finally { if (token === epoch.current) setBusy(false); }
  }
  const available = !!client && !!scope;
  return <fieldset disabled={!available || !view || busy} aria-describedby="squad-delegation-unavailable" className="mt-3">
    <legend className="text-xs font-medium text-ink-muted">Assignment and access</legend>
    {view && <p className="mt-2 break-all text-xs" data-testid="squad-current-assignee">Assigned to {view.assignee}</p>}
    <div className="mt-2 flex flex-wrap gap-2">
      <input disabled={!available || !view || !!pending || busy} aria-label="Reassign target" data-testid="squad-reassign-target"
        value={pending?.replacement ?? target} onChange={event => setTarget(event.target.value)} placeholder="Mesh key"
        className="min-w-0 flex-1 rounded border bg-transparent px-3 py-2 disabled:opacity-50" />
      <button type="button" disabled={!available || !view || !!pending || busy || !isSeaPubkey(target.trim()) || target.trim() === view.assignee}
        data-testid="squad-reassign" onClick={() => void act("start")} className="rounded border px-3 py-2 disabled:opacity-50">Reassign</button>
      {pending && <button type="button" disabled={busy} data-testid="squad-reassign-retry" onClick={() => void act("resume")}>Retry saved change</button>}
      {pending?.phase === "cancellations" && <button type="button" disabled={busy} data-testid="squad-reassign-abort" onClick={() => void act("abort")}>Cancel change</button>}
    </div>
    <p id="squad-delegation-unavailable" role="status" className="mt-2 text-xs text-ink-muted">
      {!available ? "Reassignment is unavailable until access changes can be verified. Updating an assignment or status alone does not change permissions."
        : notice || (confirmedOperation && view?.operation?.id === confirmedOperation && view.operation.phase === "complete" ? "Assignment and access changes confirmed." : pending ? "Access changes are pending. Retry the saved operation. Existing cancellations remain in effect." : view?.operation?.phase === "aborted" ? "Change canceled. Existing access cancellations remain in effect." : view ? "Changes preserve object ownership and paths." : "Loading verified assignment…")}
    </p>
  </fieldset>;
}
