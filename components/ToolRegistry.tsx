"use client";
import { useRef, useState } from "react";
import { DISCOVERY_BYTES_MAX, visorToolListings, type ToolListing } from "@/lib/tool-registry";

export function ToolRegistry() {
  const [entries, setEntries] = useState<readonly ToolListing[]>([]), [name, setName] = useState("");
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const generation = useRef(0);
  async function importVisor(file?: File) {
    if (!file) return;
    const at = ++generation.current; setMessage(""); setBusy(true);
    try {
      if (file.size > DISCOVERY_BYTES_MAX) throw Error();
      const next = visorToolListings(await file.text(), file.name);
      if (generation.current === at) setEntries(previous => [...previous.filter(row => row.source !== "visor"), ...next]);
    } catch { if (generation.current === at) setMessage("This file is not a supported Visor tool list."); }
    finally { if (generation.current === at) setBusy(false); }
  }
  async function findName() {
    const at = ++generation.current; setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/tools/registry?" + new URLSearchParams({ name }), { cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      if (generation.current !== at) return;
      if (!response.ok) { setMessage(result.error || "Registry lookup failed."); return; }
      const row: ToolListing = result.listing;
      setEntries(previous => [...previous.filter(item => item.id !== row.id), row]);
    } catch { if (generation.current === at) setMessage("Registry lookup failed. Try again later."); }
    finally { if (generation.current === at) setBusy(false); }
  }
  return <section className="mx-auto max-w-4xl px-4 py-10">
    <h1 className="text-3xl font-semibold text-ink">Tools</h1>
    <p className="mt-3 text-ink-muted">Browse web and local tools. Listing a tool does not grant permission to use it. Scanning and AIuditor review are separate steps.</p>
    <div className="mt-6 grid gap-5 sm:grid-cols-2">
      <div className="border border-rule p-4"><h2 className="font-semibold">From Visor</h2>
        <p className="my-2 text-sm text-ink-muted">Import the JSON tool list from your Visor session. It stays in this tab and is not uploaded.</p>
        <label className="block text-sm">Visor tool list<input type="file" accept=".json,application/json" disabled={busy} onChange={event => { void importVisor(event.target.files?.[0]); event.target.value = ""; }} className="mt-2 block w-full" /></label>
      </div>
      <form className="border border-rule p-4" onSubmit={event => { event.preventDefault(); void findName(); }}>
        <h2 className="font-semibold">Official MCP Registry</h2><label className="mt-2 block text-sm">Registry name<input value={name} maxLength={200} onChange={event => setName(event.target.value)} placeholder="com.example/tool" required className="my-2 w-full border border-rule bg-ground p-2" /></label>
        <button disabled={busy} className="border border-rule px-3 py-1 disabled:opacity-50">Look up name</button>
        <p className="mt-2 text-sm text-ink-muted">Checks a public catalog name. It does not verify an installed tool or approve its behavior.</p>
      </form>
    </div>
    <p role="status" className="mt-3 text-sm">{message || (busy ? "Loading tool listings…" : "")}</p>
    {entries.length === 0 ? <p className="mt-6 text-ink-muted">No tools listed yet.</p> : <ul className="mt-6 space-y-3">{entries.map(row => <li key={row.id} className="border border-rule p-4">
      <h2 className="font-semibold break-words">{row.name}</h2>
      <p className="text-sm text-ink-muted">{row.kind} · {row.sourceLabel}{row.version ? " · " + row.version : ""}</p>
      <p className="mt-2 text-sm">{row.nameStatus === "registry-verified" ? "Registry name verified" : "Name unverified"} · Use not authorized · Safety review not requested</p>
      {row.description && <p className="mt-2 whitespace-pre-wrap break-words text-sm">{row.description}</p>}
      {row.source === "visor" && <p className="mt-2 text-sm text-ink-muted">Visor reported: {row.reportedState}. Import a new list to refresh.</p>}
      {row.tools.length > 0 && <details className="mt-2"><summary>{row.tools.length} tools</summary><ul className="mt-2 space-y-2">{row.tools.map(tool => <li key={tool.name}><strong className="break-words">{tool.title}</strong><p className="whitespace-pre-wrap break-words text-sm">{tool.description}</p></li>)}</ul></details>}
      <button className="mt-3 text-sm underline" onClick={() => setEntries(previous => previous.filter(item => item.id !== row.id))}>Remove listing</button>
    </li>)}</ul>}
  </section>;
}
