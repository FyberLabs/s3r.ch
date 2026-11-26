"use client";

import { useEffect, useRef, useState } from "react";
import type { SeaPair } from "@/lib/identity/sea";
import { approveSquadAgent, revokeSquadAgent, SQUAD_AGENT_SCOPE, type SquadAgentEnrollment } from "@/lib/squad-agent-enrollment";

async function request<T>(forum: string, payload: object, signal: AbortSignal): Promise<T | null> {
  const response = await fetch("/api/squad/pilot/enrollment", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, forum }), redirect: "error", credentials: "same-origin",
    cache: "no-store", signal,
  });
  if (response.status === 403) return null;
  if (!response.ok) throw Error("Squad enrollment unavailable");
  return await response.json() as T;
}

export function SquadAgentEnrollmentPanel({ forum, label, origin, pair }: {
  forum: string; label: string; origin: string; pair: SeaPair;
}) {
  const [state, setState] = useState<SquadAgentEnrollment | null>(null);
  const [agent, setAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const action = new AbortController();
    active.current = action;
    request<SquadAgentEnrollment>(forum, { action: "list" }, action.signal).then(setState, () => {});
    return () => { action.abort(); active.current?.abort(); };
  }, [forum]);

  async function change(action: "approve" | "revoke", id: string) {
    if (!state || busy) return;
    active.current?.abort();
    const operation = new AbortController();
    active.current = operation;
    setBusy(true);
    setNotice("");
    try {
      const snapshot = await request<SquadAgentEnrollment>(forum, { action: "list" }, operation.signal);
      operation.signal.throwIfAborted();
      if (!snapshot) throw Error("Squad owner required");
      const record = action === "approve"
        ? approveSquadAgent(pair, snapshot, origin, id)
        : revokeSquadAgent(pair, snapshot, id);
      const saved = await request<{ id: string }>(forum, { action, record }, operation.signal);
      if (!saved) throw Error("Squad owner required");
      setNotice(action === "approve" ? "Agent approved." : "Agent access revoked.");
    } catch {
      if (!operation.signal.aborted) setNotice("Could not confirm the change. Check the current enrollment and try again.");
    } finally {
      if (!operation.signal.aborted) {
        const updated = await request<SquadAgentEnrollment>(forum, { action: "list" }, operation.signal).catch(() => null);
        if (!operation.signal.aborted) {
          if (updated) setState(updated);
          setBusy(false);
        }
      }
    }
  }

  if (!state) return null;
  const eligible = state.agents.filter(key => !state.grants.some(grant => grant.agent === key && grant.status === "active"));
  return <section aria-label="Squad agent enrollment" className="grid gap-2 p-3">
    <h2 className="font-semibold">Agent access</h2>
    <label className="grid gap-1">
      Agent public key for {label}
      <select value={eligible.includes(agent) ? agent : ""} onChange={event => setAgent(event.target.value)} disabled={busy}>
        <option value="">Select an agent</option>
        {eligible.map(key => <option key={key} value={key}>{key}</option>)}
      </select>
    </label>
    <button type="button" disabled={busy || !eligible.includes(agent)} onClick={() => void change("approve", agent)}>
      Approve {SQUAD_AGENT_SCOPE} for 24 hours
    </button>
    {state.grants.length > 0 && <ul className="grid gap-2">
      {state.grants.map(grant => <li key={grant.id} className="grid gap-1 break-all">
        <span>{grant.agent} · {grant.status}</span>
        <code>{grant.id}</code>
        {grant.status === "active" && <button type="button" disabled={busy} onClick={() => void change("revoke", grant.id)}>Revoke</button>}
      </li>)}
    </ul>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
