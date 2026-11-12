"use client";

import { useEffect, useRef, useState } from "react";
import { createSeaSessionClient } from "@/lib/identity/sea-session-client";
import { createSeaIdentityActivation } from "@/lib/identity/sea-identity-activation";
import { readSingleUnlockedIdentity, subscribeUnlockedMeshPair } from "@/lib/identity/unlocked-mesh";
import { readBoundedIdentityJson } from "@/lib/identity/bounded-json";
import { isSeaPubkey } from "@/lib/identity/forum-check";

type Status = { enabled: boolean; principal: string | null; expiresAt: number | null };

export function SeaIdentitySession() {
  const [status, setStatus] = useState<Status | null>(null), [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const generation = useRef(0);
  const client = useRef<ReturnType<typeof createSeaSessionClient> | null>(null);
  const activation = useRef<ReturnType<typeof createSeaIdentityActivation> | null>(null);
  const selected = readSingleUnlockedIdentity();

  useEffect(() => {
    if (window.location.protocol !== "https:") return;
    const current = createSeaSessionClient({ base: "/api/identity/sea", origin: window.location.origin });
    client.current = current;
    activation.current = createSeaIdentityActivation({ current: readSingleUnlockedIdentity, client: current });
    const changed = () => setRevision(value => value + 1);
    const off = subscribeUnlockedMeshPair(changed);
    window.addEventListener("s3rch-session-changed", changed);
    return () => { generation.current++; off(); window.removeEventListener("s3rch-session-changed", changed); client.current = null; activation.current = null; };
  }, []);

  useEffect(() => {
    const attempt = ++generation.current, abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]);
    let expiry: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        const response = await fetch("/api/identity/sea/session", { cache: "no-store", credentials: "same-origin", redirect: "error", signal });
        if (!response.ok) throw Error();
        const value = await readBoundedIdentityJson(response, 4096, signal) as Partial<Status> | null;
        if (attempt !== generation.current || !value || typeof value.enabled !== "boolean") return;
        if (!value.enabled) { setStatus(null); return; }
        if (value.principal !== null && (typeof value.principal !== "string" || !isSeaPubkey(value.principal) ||
            !Number.isSafeInteger(value.expiresAt) || value.expiresAt! <= Date.now() || value.expiresAt! > Date.now() + 300000)) throw Error();
        setStatus({ enabled: true, principal: value.principal, expiresAt: value.principal ? value.expiresAt! : null });
        if (value.principal) expiry = setTimeout(() => setRevision(number => number + 1), Math.max(0, value.expiresAt! - Date.now()));
      } catch { if (attempt === generation.current) setStatus(null); }
    })();
    return () => { abort.abort(); if (expiry) clearTimeout(expiry); };
  }, [revision]);

  async function activate() {
    if (!activation.current || busy) return;
    setBusy(true); setMessage("");
    try {
      const result = await activation.current.activate(AbortSignal.timeout(10_000));
      setMessage(result === "ready" ? "Identity session ready." : result === "changed" ? "Your saved identity changed. Retry with the identity you want to use." :
        result === "locked" ? "Unlock one saved identity to continue." : "Identity sign-in is unavailable. Try again.");
      setRevision(value => value + 1);
    } finally { setBusy(false); }
  }
  async function logout() {
    if (!client.current || busy) return;
    setBusy(true);
    try {
      const done = await client.current.logout(AbortSignal.timeout(10_000));
      setMessage(done ? "Identity session cleared." : "Could not clear the identity session. Retry sign-out.");
      if (done) setRevision(value => value + 1);
    } finally { setBusy(false); }
  }
  if (!status?.enabled) return null;
  return <div className="mt-3 space-y-2 text-sm" data-testid="sea-identity-session">
    {status.principal && <p>Identity <span className="font-mono">{status.principal.slice(0, 12)}…</span> is signed in.</p>}
    <button type="button" disabled={busy || !selected} onClick={() => void activate()} className="underline disabled:opacity-50">
      {status.principal === selected?.pair.pub ? "Refresh identity session" : "Use saved identity"}
    </button>
    {!selected && <p className="text-xs text-ink-muted">Unlock one saved identity to continue.</p>}
    {status.principal && <button type="button" disabled={busy} onClick={() => void logout()} className="ml-2 underline disabled:opacity-50">Sign out identity</button>}
    {message && <p role="status" className="text-xs text-ink-muted">{message}</p>}
  </div>;
}
