"use client";
import { useEffect, useRef, useState } from "react";
import { btnPrimary, btnSecondary } from "@/lib/brand-ui";
import { experimentHeadingVisible } from "@/lib/experiment-visibility";
import { sendFeedConversion } from "@/lib/experiment-navigation";
type Display = { authenticated: boolean; variant: string; cohort: string; display: string; expiresAt: number };
async function request(body: { action: string; allowed?: boolean; display?: string; eventId?: string }) {
  const response = await fetch("/api/experiments", { method: body.action === "status" ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { "Content-Type": "application/json" }, body: body.action === "status" ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error("Experiments unavailable");
  return response.json();
}
export function ExperimentHero() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const changed = () => setRevision(value => value + 1);
    const storage = (event: StorageEvent) => { if (event.key === "s3rch-session-changed") changed(); };
    window.addEventListener("s3rch-session-changed", changed); window.addEventListener("storage", storage);
    return () => { window.removeEventListener("s3rch-session-changed", changed); window.removeEventListener("storage", storage); };
  }, []);
  return <HeroScope key={revision} />;
}
function HeroScope() {
  const [display, setDisplay] = useState<Display | null>(null), [consented, setConsented] = useState(false), [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const heading = useRef<HTMLHeadingElement>(null), generation = useRef(0), alive = useRef(true);
  const ids = useRef(new Map<string, { exposure: string; conversion: string }>());
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  function serialized(work: () => Promise<void>) { const next = chain.current.then(work, work); chain.current = next.catch(() => {}); return next; }
  useEffect(() => {
    alive.current = true; let pending = false; const currentGeneration = generation;
    const refresh = () => {
      if (pending) return; pending = true; const revision = generation.current;
      void serialized(async () => {
        try {
          const state = await request({ action: "status" });
          if (!alive.current || revision !== generation.current) return;
          setEnabled(state.enabled === true); setConsented(state.consented === true);
          if (!state.enabled || !state.consented) { setDisplay(null); return; }
          const next = await request({ action: "evaluate" });
          if (alive.current && revision === generation.current) setDisplay(next.display ? next : null);
        } catch { /* The independent expiry timer still returns to control. */ }
      }).finally(() => { pending = false; });
    };
    refresh(); const timer = setInterval(refresh, 30000);
    return () => { alive.current = false; currentGeneration.current++; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!display) return;
    const remaining = display.expiresAt * 1000 - Date.now();
    if (remaining <= 0 || remaining > 300000) { setDisplay(null); return; }
    const timer = setTimeout(() => setDisplay(null), remaining);
    return () => clearTimeout(timer);
  }, [display]);
  useEffect(() => {
    if (!display || !heading.current || !consented) return;
    const identity = `${display.cohort}:${display.variant}`;
    const action = ids.current.get(identity) ?? { exposure: crypto.randomUUID(), conversion: crypto.randomUUID() };
    ids.current.set(identity, action);
    let sent = false, visible = false, cancelled = false;
    const attempt = () => {
      if (sent || cancelled || !visible || document.visibilityState !== "visible") return;
      sent = true;
      void serialized(async () => {
        if (cancelled || !alive.current || Date.now() >= display.expiresAt * 1000) return;
        try {
          await request({ action: "exposure", display: display.display, eventId: action.exposure });
        } catch { /* The durable server queue retries with the same action ID. */ }
      });
    };
    const observer = new IntersectionObserver(entries => { visible = experimentHeadingVisible(entries); attempt(); }, { threshold: 0.5 });
    observer.observe(heading.current); document.addEventListener("visibilitychange", attempt);
    return () => { cancelled = true; observer.disconnect(); document.removeEventListener("visibilitychange", attempt); };
  }, [display, consented]);
  async function consent() {
    generation.current++; setDisplay(null); setBusy(true); setMessage("");
    const allowed = !consented;
    await serialized(async () => {
      try {
        const value = await request({ action: "consent", allowed });
        if (!alive.current) return;
        setConsented(value.consented === true);
        if (allowed && value.consented) { const next = await request({ action: "evaluate" }); if (alive.current) setDisplay(next.display ? next : null); }
      } catch { if (alive.current) setMessage("Could not update page preferences. Please try again."); }
      finally { if (alive.current) setBusy(false); }
    });
  }
  return <div data-testid="experiment-hero">
    <h1 ref={heading} className="max-w-xl text-4xl font-semibold tracking-tight text-ink sm:text-6xl">{display?.variant === "create" ? "Create together, with people and AI." : "Where humans and AI create together."}</h1>
    <p className="mt-6 max-w-xl text-lg text-ink-muted sm:text-xl">One network for the work behind today's media, and the real moments in between.</p>
    <p className="mt-8 flex flex-wrap gap-3">
      <a href="#sign-in" className={`inline-flex ${btnPrimary}`}>Join s3r.ch</a>
      <a href="/feed" className={`inline-flex ${btnSecondary}`} onClick={event => {
        if (!display?.authenticated || !consented || Date.now() >= display.expiresAt * 1000 || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        void sendFeedConversion({ action: "conversion", display: display.display, eventId: crypto.randomUUID() }, () => window.location.assign("/feed"));
      }}>Explore the public feed</a>
    </p>
    {(enabled || consented) && <button type="button" disabled={busy} onClick={() => void consent()} className="mt-2 text-xs underline text-ink-muted">
      {consented ? "Turn off page experiments and delete pending events" : "Allow page experiments and product analytics"}
    </button>}
    {message && <p role="status">{message}</p>}
    <p className="mt-4 max-w-xl text-sm text-ink-muted">Live today: posts, rooms, forums and squads. Media, meetings and more are coming in v1.</p>
  </div>;
}
