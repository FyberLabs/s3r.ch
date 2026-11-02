"use client";

import { useEffect, useRef, useState } from "react";
import type { FeedGun } from "./GunPeerProvider";
import { createForumDrawer, type DrawerAuthority, type DrawerKind, type DrawerRecord } from "@/lib/forum-drawer";
import { checkForumChildWrite } from "@/lib/identity/forum-child-write";
import { isForumObjectId } from "@/lib/identity/forum-check";
import { readForumSignature, signForumRecord } from "@/lib/forum-sign";
import type { SeaPair } from "@/lib/identity/sea";
import { btnSecondary, field } from "@/lib/brand-ui";
import { shortSea, formatClock } from "@/lib/forum-squad";

/** Live-only child view. Never receives fixture detail or restored replay caches. */
export function ForumDrawerRecords(props: {
  forum: string; agent: string; authority: DrawerAuthority; gun: FeedGun | null;
  viewerKey: string | null; active: boolean; getPair: () => SeaPair | null;
}) {
  const latest = useRef(props); latest.current = props;
  const [, redraw] = useState(0);
  const [binding, setBinding] = useState<{ authority: DrawerAuthority; forum: string; agent: string;
    controller: ReturnType<typeof createForumDrawer> } | null>(null);
  const controller = binding?.authority === props.authority && binding.forum === props.forum && binding.agent === props.agent
    ? binding.controller : null;
  useEffect(() => {
    const c = createForumDrawer({
      forum: props.forum, agent: props.agent, authority: props.authority,
      active: () => latest.current.active,
      viewer: () => {
        const key = latest.current.viewerKey;
        return key ? latest.current.authority.graph.principalForKey(key, Math.floor(Date.now() / 1000)) : null;
      },
      verify: readForumSignature,
    });
    setBinding({ authority: props.authority, forum: props.forum, agent: props.agent, controller: c });
    const off = c.subscribe(() => redraw(n => n + 1));
    const timer = setInterval(() => c.refresh(), 1000);
    return () => { off(); clearInterval(timer); c.dispose(); };
  }, [props.forum, props.agent, props.authority]);
  useEffect(() => {
    if (!controller) return;
    if (props.gun && props.active) controller.connect(props.gun);
    else controller.disconnect();
    return () => controller.disconnect();
  }, [controller, props.gun, props.active]);
  const [kind, setKind] = useState<DrawerKind>("update");
  const [destination, setDestination] = useState("");
  const [body, setBody] = useState("");
  const [target, setTarget] = useState("");
  const [state, setState] = useState<DrawerRecord["state"]>("pending");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const rows = controller?.rows() ?? [], now = Math.floor(Date.now() / 1000);
  const writer = props.viewerKey ? props.authority.graph.principalForKey(props.viewerKey, now) : null;
  const destinations = writer && props.active ? props.authority.graph.ownedObjects(props.agent).filter(id =>
    isForumObjectId(id, kind) && checkForumChildWrite(props.authority.graph, props.forum, props.agent, id, writer, now).allowed) : [];
  const prompt = rows.filter(r => r.kind === "prompt").at(-1);
  async function publish(remove?: DrawerRecord) {
    if (!controller) return;
    const pair = latest.current.getPair(), at = Math.floor(Date.now() / 1000);
    const principal = pair && latest.current.authority.graph.principalForKey(pair.pub, at);
    if (!pair || !principal) { setNotice("A current signing key is required."); return; }
    const id = remove?.id ?? destination;
    const rev = controller.revision(id) + 1;
    const record: DrawerRecord = { domain: "s3rch-forum-child-v1", kind, forumId: props.forum, agent: props.agent,
      id, body: body.trim(), target: kind === "artifact" ? target.trim() : "", state: kind === "subtask" ? state : "",
      ...remove, rev, issuedAt: at, writer: principal, stated: remove ? 0 : 1 };
    setBusy(true); setNotice("");
    try {
      const result = await controller.publish(record, { key: pair.pub, sign: row => signForumRecord(row, pair) });
      setNotice(result === "signed" ? "Sent. Waiting for a verified copy from the mesh." :
        result === "offline" ? "The mesh is unavailable. Try again after reconnecting." :
          "Current destination, target, or signing authority is unavailable. Refresh before retrying.");
    } catch { setNotice("The record could not be sent. Refresh before retrying."); }
    finally { setBusy(false); }
  }
  function removeButton(row: DrawerRecord) {
    return writer && checkForumChildWrite(props.authority.graph, props.forum, props.agent, row.id, writer, now).allowed
      ? <button type="button" className={btnSecondary} disabled={busy} onClick={() => void publish(row)}>Remove</button> : null;
  }
  return <section aria-label="Verified drawer records" className="mt-4 min-w-0 space-y-3 [overflow-wrap:anywhere]">
    <p role="status" className="text-xs text-ink-muted">{rows.length
      ? "Verified records received so far. More records may arrive."
      : "Only status data is available. Waiting for verified child records and current access."}</p>
    {controller?.atCapacity() ? <p role="status" className="text-xs text-ink-muted">This drawer has reached its record limit. More records may exist.</p> : null}
    <h3 className="text-xs font-semibold uppercase text-ink-muted">Subtasks</h3>
    <ul className="space-y-2 text-sm">{rows.filter(r => r.kind === "subtask").map(r =>
      <li key={r.id}><span className="text-ink-muted">{r.state}</span> {r.body} {removeButton(r)}</li>)}</ul>
    <h3 className="text-xs font-semibold uppercase text-ink-muted">Last prompt</h3>
    {prompt ? <p className="text-sm">{prompt.body} <span className="text-ink-muted"> · {shortSea(prompt.writer)}</span> {removeButton(prompt)}</p> : null}
    <h3 className="text-xs font-semibold uppercase text-ink-muted">Updates</h3>
    <ul className="space-y-2 text-sm">{rows.filter(r => r.kind === "update").map(r =>
      <li key={r.id}><span className="font-data text-ink-muted">{formatClock(r.issuedAt)}</span> {r.body} {removeButton(r)}</li>)}</ul>
    <h3 className="text-xs font-semibold uppercase text-ink-muted">Artifacts</h3>
    <ul className="space-y-2 text-sm">{rows.filter(r => r.kind === "artifact").map(r =>
      <li key={r.id}>{r.body}<code className="block break-all text-xs text-ink-muted">{r.target}</code>{removeButton(r)}</li>)}</ul>
    <details>
      <summary className="cursor-pointer text-sm">Publish a record</summary>
      <p className="mt-2 text-xs text-ink-muted">Choose a destination already admitted by the owner. Publishing does not create access.</p>
      <label className="mt-2 block text-xs">Record type
        <select className={`${field} mt-1 block w-full`} value={kind} onChange={e => { setKind(e.target.value as DrawerKind); setDestination(""); }}>
          {(["update", "subtask", "prompt", "artifact"] as const).map(k => <option key={k}>{k}</option>)}
        </select>
      </label>
      <label className="mt-2 block text-xs">Destination
        <select className={`${field} mt-1 block w-full`} value={destinations.includes(destination) ? destination : ""} onChange={e => {
          const id = e.target.value; setDestination(id);
          const row = rows.find(r => r.id === id); setBody(row?.body ?? ""); setTarget(row?.target ?? ""); setState(row?.state || "pending");
        }}>
          <option value="">Select an admitted destination</option>
          {destinations.map(id => <option key={id} value={id}>{kind} · {id.slice(-12)}</option>)}
        </select>
      </label>
      {!destinations.length ? <p className="text-xs text-ink-muted">No writable destinations are available.</p> : null}
      <label className="mt-2 block text-xs">Text<textarea className={`${field} mt-1 block w-full`} value={body} maxLength={2048} onChange={e => setBody(e.target.value)} /></label>
      {kind === "subtask" ? <label className="mt-2 block text-xs">State<select className={`${field} mt-1 block w-full`} value={state} onChange={e => setState(e.target.value as DrawerRecord["state"])}>
        {["pending", "running", "done", "failed"].map(s => <option key={s}>{s}</option>)}
      </select></label> : null}
      {kind === "artifact" ? <label className="mt-2 block text-xs">Referenced object<input className={`${field} mt-1 block w-full`} value={target} onChange={e => setTarget(e.target.value)} /></label> : null}
      <button className={btnSecondary} type="button" disabled={busy || !destinations.includes(destination) || !body.trim()} onClick={() => void publish()}>Publish</button>
    </details>
    {notice ? <p role="status" className="text-xs text-ink-muted">{notice}</p> : null}
  </section>;
}
