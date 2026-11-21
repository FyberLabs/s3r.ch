"use client";

import { useEffect, useRef, useState } from "react";
import { shortSea } from "@/lib/forum-squad";
import { btnSecondary, field } from "@/lib/brand-ui";

type Bot = { id: string; principal: string };
type Desired = "running" | "paused" | "stopped";
const endpoint = "/api/squad/pilot/plane/bot-controls";

async function request(body: object, signal: AbortSignal) {
  return fetch(endpoint, { method: "POST", cache: "no-store", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, ...body }) });
}

export function SquadBotControls() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [selected, setSelected] = useState("");
  const [desired, setDesired] = useState<Desired | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await request({}, controller.signal);
        if (!response.ok) return;
        const value = await response.json() as { bots?: Bot[] };
        if (!controller.signal.aborted && Array.isArray(value.bots)) setBots(value.bots);
      } catch { /* A disconnected session has no available controls. */ }
    })();
    return () => { controller.abort(); pending.current?.abort(); };
  }, []);

  async function control(botId: string, action?: "pause" | "resume") {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setSelected(botId);
    setDesired(null);
    setMessage("");
    setBusy(!!botId);
    if (!botId) return;
    try {
      const response = await request({ bot_id: botId, action }, controller.signal);
      if (controller.signal.aborted) return;
      if (response.status === 409) {
        setMessage("No current forum assignment.");
        return;
      }
      if (!response.ok) throw Error("Control unavailable");
      const value = await response.json() as { desired?: Desired };
      if (value.desired !== "paused" && value.desired !== "running" && value.desired !== "stopped") throw Error("Control unavailable");
      if (!controller.signal.aborted) setDesired(value.desired);
    } catch {
      if (!controller.signal.aborted) setMessage("Plane could not confirm the bot state.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  if (!bots.length) return null;
  return <details className="mx-3 mb-3 border border-rule bg-panel p-3">
    <summary className="cursor-pointer font-semibold">Forum bot controls</summary>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <label htmlFor="squad-plane-bot">Bot</label>
      <select id="squad-plane-bot" className={field} value={selected}
        onChange={event => { void control(event.currentTarget.value); }}>
        <option value="">Select a bot</option>
        {bots.map(bot => <option key={bot.id} value={bot.id}>{shortSea(bot.principal)}</option>)}
      </select>
      {selected && <button type="button" className={btnSecondary} disabled={busy}
        onClick={() => { void control(selected); }}>Refresh</button>}
      {desired === "running" && <button type="button" className={btnSecondary} disabled={busy}
        onClick={() => { void control(selected, "pause"); }}>Pause</button>}
      {desired === "paused" && <button type="button" className={btnSecondary} disabled={busy}
        onClick={() => { void control(selected, "resume"); }}>Resume</button>}
      <p role="status" className="text-sm text-ink-muted">{busy ? "Checking Plane…" : message ||
        (desired === "paused" ? "Paused" : desired === "running" ? "Running" : desired === "stopped" ? "Stopped" : "")}</p>
    </div>
  </details>;
}
