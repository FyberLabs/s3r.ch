"use client";

import { useEffect, useRef, useState } from "react";
import { createStartupLinkedLogin, snapshotStartupLoginBinding, type StartupLinkedIdentity } from "@/lib/identity/startup-linked-login";
import { loadStartupExistingKey } from "@/lib/identity/startup-existing-key";
import { readBoundedIdentityJson } from "@/lib/identity/bounded-json";
import { forgetUnlockedMeshPair, readUnlockedMeshPair, readUnlockedMeshRevision, subscribeUnlockedMeshPair } from "@/lib/identity/unlocked-mesh";
import { identitySessionChanged } from "./useIdentitySession";

export function StartupLinkedLogin({ address }: { address: string | null | undefined }) {
  const [enabled, setEnabled] = useState(false), [retry, setRetry] = useState(0);
  const [identity, setIdentity] = useState<StartupLinkedIdentity | null>(null);
  const [hasCredential, setHasCredential] = useState(false);
  const [message, setMessage] = useState("");
  const [organization, setOrganization] = useState("");
  const operation = useRef(0);
  const controller = useRef<ReturnType<typeof createStartupLinkedLogin> | null>(null);

  useEffect(() => {
    const refresh = () => setRetry(value => value + 1);
    const storage = (event: StorageEvent) => { if (event.key === "s3rch-session-changed") refresh(); };
    window.addEventListener("s3rch-session-changed", refresh); window.addEventListener("storage", storage);
    return () => { window.removeEventListener("s3rch-session-changed", refresh); window.removeEventListener("storage", storage); };
  }, []);

  useEffect(() => {
    if (address === undefined) return;
    const attempt = ++operation.current, abort = new AbortController();
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const active = () => !abort.signal.aborted && operation.current === attempt;
    setIdentity(null); controller.current?.logout(); controller.current = null;
    const off = subscribeUnlockedMeshPair(() => {
      if (active() && controller.current && !controller.current.current()) {
        setIdentity(null); setMessage("Unlock your saved identity and retry.");
      }
    });
    void (async () => {
      try {
        const availability = await fetch("/api/identity/startup/availability", { cache: "no-store", signal: abort.signal });
        const available = await readBoundedIdentityJson(availability, 1024, abort.signal) as { enabled?: unknown };
        if (!active()) return;
        setEnabled(available.enabled === true);
        if (available.enabled !== true) return;
        const response = await fetch("/api/identity/startup/session", { cache: "no-store", signal: abort.signal });
        if (!active()) return;
        if (!response.ok) { setHasCredential(false); setMessage(""); return; }
        const payload = await readBoundedIdentityJson(response, 16384, abort.signal) as { binding?: unknown; identity?: unknown; verifiedSubject?: unknown; expiresAt?: unknown };
        const binding = snapshotStartupLoginBinding(payload?.binding);
        if (!binding || typeof payload.verifiedSubject !== "string" || typeof payload.expiresAt !== "number" ||
            !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= Date.now() || payload.expiresAt > Date.now() + 300000 || !active()) return;
        setHasCredential(true);
        const key = await loadStartupExistingKey(binding.sea_public_key, address);
        if (!active() || payload.expiresAt <= Date.now()) return;
        if (key.state !== "ready") {
          setMessage(key.state === "conflict" ? "This account uses a different saved identity. Sign out before switching." :
            key.state === "missing" ? "The configured identity is not saved in this browser. Restore your existing key to continue." : "Unlock your saved identity and retry.");
          return;
        }
        const login = createStartupLinkedLogin({ expected: binding, currentKey: () => readUnlockedMeshPair(key.address),
          keyRevision: readUnlockedMeshRevision, lookup: async () => ({ identity: payload.identity, verifiedSubject: payload.verifiedSubject as string }) });
        controller.current = login;
        const resolved = await login.login();
        if (!active()) { login.logout(); return; }
        setIdentity(resolved);
        setOrganization(resolved?.organizations[0]?.id ?? "");
        setMessage(resolved ? "" : "The linked account does not match your saved identity.");
        expiry = setTimeout(() => {
          if (active()) { login.logout(); setIdentity(null); setMessage("Sign in again to refresh your linked account."); }
        }, Math.max(0, payload.expiresAt - Date.now()));
      } catch { if (active()) setMessage("Linked sign-in is temporarily unavailable."); }
    })();
    return () => { if (expiry) clearTimeout(expiry); abort.abort(); off(); controller.current?.logout(); controller.current = null; };
  }, [address, retry]);

  async function logout() {
    operation.current++; controller.current?.logout(); setIdentity(null); forgetUnlockedMeshPair();
    try {
      const result = await fetch("/api/identity/logout", { method: "POST" });
      if (!result.ok) throw Error();
      setHasCredential(false); identitySessionChanged(); setMessage("");
    } catch { setMessage("The local key is locked. Retry sign-out to clear the linked credential."); }
  }
  if (!enabled) return null;
  const selected = identity?.organizations.find(row => row.id === organization);
  return <div className="mt-3 space-y-2 text-sm" data-testid="startup-linked-login">
    {identity ? <>
      <p>Connected existing identity <span className="font-mono">{identity.sea_public_key.slice(0, 12)}…</span></p>
      <label className="flex items-center gap-2">Organization
        <select value={selected?.id ?? ""} onChange={event => {
          if (identity.organizations.some(row => row.id === event.target.value)) setOrganization(event.target.value);
        }} className="rounded border px-2 py-1">
          {identity.organizations.map(row => <option key={row.id} value={row.id}>{row.slug}</option>)}
        </select>
      </label>
      {selected && <p className="text-xs text-ink-muted">{selected.roles.join(", ")}</p>}
      <button type="button" onClick={() => void logout()} className="underline">Sign out linked account</button>
    </> : <a href="/api/identity/startup/start" className="underline">Sign in with your linked organization account</a>}
    {!identity && hasCredential && <button type="button" onClick={() => void logout()} className="ml-2 underline">Sign out linked account</button>}
    {message && <p role="status" className="text-xs text-ink-muted">{message}</p>}
    {message && <button type="button" onClick={() => setRetry(value => value + 1)} className="text-xs underline">Retry saved identity</button>}
  </div>;
}
