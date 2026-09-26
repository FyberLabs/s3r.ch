"use client";

import { useEffect, useState } from "react";
import { deskPanels, type DeskPanel, type DeskRead } from "@/lib/forum-desktop";

const POLL_MS = 4000;

export function ForumDesk() {
  const [panels, setPanels] = useState<DeskPanel[] | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    let stopped = false;
    async function load() {
      try {
        const response = await fetch("/api/forum", { cache: "no-store" });
        if (stopped) return;
        if (response.status === 401) {
          setSignedOut(true);
          setPanels([]);
          return;
        }
        if (!response.ok) return;
        const body = (await response.json()) as DeskRead;
        setSignedOut(false);
        setPanels(deskPanels(body));
      } catch {
        if (!stopped) setPanels((current) => current);
      }
    }
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  if (signedOut) {
    return <p className="mt-6 text-sm text-ink-muted">Sign in to see a forum channel.</p>;
  }
  if (!panels) {
    return <p className="mt-6 text-sm text-ink-muted">Loading the forum.</p>;
  }
  if (panels.length === 0) {
    return <p className="mt-6 text-sm text-ink-muted">Nothing on this login.</p>;
  }

  return (
    <div className="mt-6 flex flex-col gap-8">
      {panels.map((panel) => (
        <DeskPanelView key={`${panel.role}:${panel.owner}`} panel={panel} />
      ))}
    </div>
  );
}

function DeskPanelView({ panel }: { panel: DeskPanel }) {
  const title = panel.role === "owner" ? "Your channel" : "Shared channel";
  return (
    <section className="border border-rule bg-panel p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <p className="max-w-full truncate font-mono text-xs text-ink-muted">{panel.owner}</p>
      </div>
      <div className="mt-4 flex flex-col gap-4 md:flex-row md:items-start">
        <figure className="w-full md:w-3/5">
          {panel.snapshotUrl ? (
            <img
              src={panel.snapshotUrl}
              alt="Latest desktop snapshot"
              className="max-h-[45vh] w-full border border-rule bg-ground object-contain md:max-h-[70vh]"
            />
          ) : (
            <p className="border border-rule bg-ground px-3 py-8 text-sm text-ink-muted">
              No desktop snapshot yet.
            </p>
          )}
          {panel.snapshotHandle ? (
            <figcaption className="mt-2 truncate font-mono text-xs text-ink-muted">
              {panel.snapshotHandle}
            </figcaption>
          ) : null}
        </figure>
        <div className="w-full md:w-2/5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Terminal
          </h3>
          {panel.thinking.length === 0 ? (
            <p className="mt-2 text-sm text-ink-muted">No terminal activity yet.</p>
          ) : (
            <ol className="mt-2 max-h-[50vh] space-y-2 overflow-y-auto md:max-h-[70vh]">
              {panel.thinking.map((line, index) => (
                <li key={`${line.kind}:${index}`} className="text-sm text-ink">
                  <span className="mr-2 font-mono text-xs text-ink-muted">{line.kind}</span>
                  <span className="break-words">{line.text}</span>
                </li>
              ))}
            </ol>
          )}
          <HandleLine label="files" handles={panel.files} />
          <HandleLine label="secrets" handles={panel.secrets} />
        </div>
      </div>
    </section>
  );
}

function HandleLine({ label, handles }: { label: string; handles: string[] }) {
  if (handles.length === 0) return null;
  return (
    <p className="mt-3 break-words font-mono text-xs text-ink-muted">
      {label} {handles.join(" ")}
    </p>
  );
}
