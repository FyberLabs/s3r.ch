"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { btnSecondary, field } from "@/lib/brand-ui";
import { shortSea } from "@/lib/forum-squad";
import { SquadBriefPanel } from "./SquadBriefPanel";
import { squadProjectDelegationRequest } from "@/lib/squad-project-client";
import type { ProjectBoard, ProjectLabel, ProjectNode } from "@/lib/squad-project";

type Board = ProjectBoard & { canEdit: boolean; canDelegate: boolean; bots: { id: string; principal: string }[] };
const endpoint = "/api/squad/pilot/project";
class ProjectRequestError extends Error {
  constructor(readonly status: number, code?: string) {
    super(code === "active-assignment" ? "The previous assignment is still active."
      : code === "assignment-in-progress" ? "Plane is confirming this assignment. Retry shortly."
      : status === 409 ? "The project changed. Refresh and try again."
      : status === 403 ? "Your session cannot perform this action."
      : status === 400 ? "Check the fields and the Plane intent."
      : "The project request could not be confirmed.");
  }
}
async function request(forum: string, body: object, signal: AbortSignal, token?: string): Promise<Board> {
  const response = await fetch(endpoint, { method: "POST", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify({ forum, ...body }),
  });
  const result = await response.json();
  if (!response.ok) throw new ProjectRequestError(response.status, result?.error);
  return result;
}

export function SquadProjectPanel({ forum }: { forum: string }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [taskId, setTaskId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [title, setTitle] = useState("");
  const [parentId, setParentId] = useState("");
  const [outcome, setOutcome] = useState("");
  const [label, setLabel] = useState<ProjectLabel>("partner-pilot");
  const [issue, setIssue] = useState("");
  const [source, setSource] = useState("");
  const [intent, setIntent] = useState("");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const active = useRef<AbortController | null>(null);
  const createNodeId = useRef("");
  const createTask = useRef<{ key: string; id: string } | null>(null);
  const draftNode = board?.nodes.find(node => node.id === nodeId);
  const task = board?.tasks.find(candidate => candidate.id === taskId);
  const history = board?.ledger.filter(run => run.taskId === taskId) ?? [];

  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    setTaskId(new URLSearchParams(window.location.search).get("task") ?? "");
    void request(forum, { action: "board" }, controller.signal).then(value => {
      if (!controller.signal.aborted) setBoard(value);
    }, error => {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Unable to load project.");
    });
    return () => { controller.abort(); active.current?.abort(); };
  }, [forum]);

  async function send(body: object, options?: { token?: string; success?: () => void; refreshOnError?: boolean }) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setMessage("");
    try {
      const result = await request(forum, body, controller.signal, options?.token);
      if (controller.signal.aborted) return;
      setBoard(current => ({ ...current, ...result }));
      options?.success?.();
    } catch (error) {
      if (controller.signal.aborted) return;
      setMessage(error instanceof Error ? error.message : "Unable to update project.");
      if (error instanceof ProjectRequestError && (error.status === 401 || error.status === 403)) setBoard(null);
      else if (options?.refreshOnError) {
        try {
          const current = await request(forum, { action: "board" }, controller.signal);
          if (!controller.signal.aborted) setBoard(current);
        } catch {
          // Keep the original delegation error visible and allow a manual refresh.
        }
      }
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        setCredential("");
      }
    }
  }

  function selectNode(node?: ProjectNode) {
    setNodeId(node?.id ?? "");
    setTitle(node?.title ?? "");
    setParentId(node?.parentId ?? "");
    createNodeId.current = "";
  }
  function openTask(id: string) {
    setTaskId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("task", id);
    window.history.replaceState(window.history.state, "", url);
  }

  function saveNode(event: FormEvent) {
    event.preventDefault();
    if (!board) return;
    const id = nodeId || (createNodeId.current ||= crypto.randomUUID());
    void send({ action: "node", cursor: board.cursor, id, parentId: parentId || null, title: title.trim() },
      { success: () => { setNodeId(id); createNodeId.current = ""; } });
  }
  function saveTask(event: FormEvent) {
    event.preventDefault();
    if (!draftNode) return;
    const detail = { action: "create-task", nodeId: draftNode.id, outcome: outcome.trim(), label,
      issue: issue.trim() || null, sources: source.trim() ? [source.trim()] : [] };
    const key = JSON.stringify(detail);
    if (createTask.current?.key !== key) createTask.current = { key, id: crypto.randomUUID() };
    const { id } = createTask.current;
    void send({ ...detail, id }, { success: () => {
      createTask.current = null;
      setOutcome("");
      setIssue("");
      setSource("");
      openTask(id);
    } });
  }
  function assign(event: FormEvent) {
    event.preventDefault();
    if (!task || !board) return;
    let parsed: unknown;
    try { parsed = JSON.parse(intent); }
    catch { setMessage("Enter the staged Plane intent as JSON."); return; }
    const body = squadProjectDelegationRequest(board, task, parsed);
    void send(body, { token: credential.trim(), refreshOnError: true, success: () => setIntent("") });
  }
  function branches(parent: string | null): React.ReactNode {
    const nodes = board?.nodes.filter(node => node.parentId === parent) ?? [];
    return nodes.length > 0 && <ul className="space-y-1 pl-4">{nodes.map(node =>
      <li key={node.id}>
        <button type="button" className="underline" aria-pressed={node.id === nodeId}
          onClick={() => selectNode(node)}>{node.title}</button>
        {board?.tasks.filter(item => item.nodeId === node.id).map(item =>
          <button type="button" className="ml-2 text-sm underline" key={item.id} onClick={() => openTask(item.id)}>{item.outcome}</button>)}
        {branches(node.id)}
      </li>)}</ul>;
  }

  return <details open={taskId ? true : undefined} className="mx-3 mb-3 border border-rule bg-panel p-3">
    <summary className="cursor-pointer font-semibold">Squad project</summary>
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <button type="button" className={btnSecondary} disabled={busy} onClick={() => void send({ action: "board" })}>Refresh project</button>
      <p aria-live="polite" className="text-sm">{busy ? "Updating project…" : message}</p>
    </div>
    {board && <div className="mt-3 grid gap-5 md:grid-cols-2">
      <section className="space-y-2">
        <h2 className="font-semibold">Mind map</h2>
        {branches(null)}
        {board.canEdit && <form className="grid gap-2" onSubmit={saveNode}>
          <button type="button" className={btnSecondary} onClick={() => selectNode()}>New node</button>
          <label>Node title <input required className={field} value={title} maxLength={120} onChange={e => setTitle(e.currentTarget.value)} /></label>
          <label>Parent <select className={field} value={parentId} onChange={e => setParentId(e.currentTarget.value)}>
            <option value="">Root</option>
            {board.nodes.filter(node => node.id !== nodeId).map(node => <option key={node.id} value={node.id}>{node.title}</option>)}
          </select></label>
          <button className={btnSecondary} disabled={busy}>Save node</button>
        </form>}
        {board.canEdit && draftNode && <form className="grid gap-2" onSubmit={saveTask}>
          <h3 className="font-semibold">Task from {draftNode.title}</h3>
          <label>Outcome <input required className={field} maxLength={240} value={outcome} onChange={e => setOutcome(e.currentTarget.value)} /></label>
          <label>Label <select className={field} value={label} onChange={e => setLabel(e.currentTarget.value as ProjectLabel)}>
            <option value="partner-pilot">partner-pilot</option><option value="pricing">pricing</option>
          </select></label>
          <label>GitHub issue URL <input type="url" className={field} value={issue} onChange={e => setIssue(e.currentTarget.value)} /></label>
          <label>Source URL <input type="url" className={field} value={source} onChange={e => setSource(e.currentTarget.value)} /></label>
          <button className={btnSecondary} disabled={busy}>Create task</button>
        </form>}
      </section>
      <section className="space-y-2">
        <h2 className="font-semibold">Project tasks</h2>
        <ul className="space-y-1">{board.tasks.map(item => <li key={item.id}>
          <button type="button" className="underline" aria-pressed={item.id === taskId} onClick={() => openTask(item.id)}>{item.outcome}</button> · {item.label}
        </li>)}</ul>
        {task && <div className="space-y-2">
          <p>Task ID <code className="break-all">{task.id}</code></p>
          <p>Owner {shortSea(task.owner)} · Revision {task.revision}</p>
          {task.issue && <a href={task.issue} rel="noreferrer" className="underline">GitHub issue</a>}
          {task.sources.map(url => <p key={url}><a href={url} rel="noreferrer" className="break-all underline">{url}</a></p>)}
          <ul>{history.map(run => <li key={run.cursor}>{shortSea(run.requestedBy)} → {shortSea(run.delegate)} · {run.status} · Revision {run.taskRevision}</li>)}</ul>
          <SquadBriefPanel key={task.id} forum={forum} taskId={task.id} />
          {board.canDelegate && board.bots.length > 0 && <form className="grid gap-2" onSubmit={assign}>
            <h3 className="font-semibold">Delegate task</h3>
            <p className="text-sm">Use a staged Plane intent for a current bot assignment.</p>
            <ul className="text-xs">{board.bots.map(bot => <li key={bot.id}><code>{bot.id}</code> · {shortSea(bot.principal)}</li>)}</ul>
            <label>Plane intent <textarea required className={field} value={intent} onChange={e => setIntent(e.currentTarget.value)} /></label>
            <label>Plane owner bearer <input required type="password" autoComplete="off" className={field} value={credential}
              onChange={e => setCredential(e.currentTarget.value)} /></label>
            <button className={btnSecondary} disabled={busy}>Delegate to agent</button>
          </form>}
        </div>}
      </section>
    </div>}
  </details>;
}
