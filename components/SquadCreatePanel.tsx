"use client";

import { useState } from "react";
import type { SeaPair } from "@/lib/identity/sea";
import { squadForumBootstrapRows } from "@/lib/squad-forum-bootstrap";
import type { LiveSquadSpec } from "@/lib/squad-view";

type Props = {
  pair: SeaPair | null;
  onCreated: (squad: LiveSquadSpec) => void;
};

export function SquadCreatePanel({ pair, onCreated }: Props) {
  const [label, setLabel] = useState("My squad");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!pair || busy) return;
    setBusy(true);
    setError(null);
    try {
      const at = Math.floor(Date.now() / 1000);
      const rows = await squadForumBootstrapRows(pair, at);
      const response = await fetch("/api/squad/create", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, label: label.trim(), rows }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.squad) {
        setError("Could not create squad.");
        return;
      }
      onCreated(body.squad as LiveSquadSpec);
    } catch {
      setError("Could not create squad.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-6 rounded-lg border border-ink/10 bg-canvas p-4">
      <h2 className="text-lg font-semibold text-ink">Create a squad</h2>
      <p className="mt-1 text-sm text-ink-muted">
        A squad is a forum you own under your SEA identity. Members join only through grants you sign.
      </p>
      <label className="mt-4 block text-sm font-medium text-ink" htmlFor="squad-label">
        Name
      </label>
      <input
        id="squad-label"
        className="mt-1 w-full max-w-md rounded border border-ink/20 bg-surface px-3 py-2 text-ink"
        value={label}
        disabled={!pair || busy}
        onChange={event => setLabel(event.target.value)}
      />
      <button
        type="button"
        className="mt-4 rounded bg-signal px-4 py-2 text-sm font-semibold text-surface disabled:opacity-50"
        disabled={!pair || busy || !label.trim()}
        onClick={() => void create()}
      >
        {busy ? "Creating…" : "Create squad"}
      </button>
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
      {!pair && <p className="mt-2 text-sm text-ink-muted">Unlock your SEA identity to create a squad.</p>}
    </div>
  );
}