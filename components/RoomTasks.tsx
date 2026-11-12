"use client";

import { useEffect, useRef, useState } from "react";
import { admitComposedChat, type ChatMessage } from "@/lib/chat";
import { canUseRoomTasks, composeRoomTask, roomTasks, TASK_STATUSES, TASK_TITLE_MAX, type RoomTask, type TaskAction, type TaskStatus } from "@/lib/room-tasks";
import { useSeeAcl, type SeeAclContextValue } from "./SeeAclProvider";
import { objectOwner, useIdentitySession } from "./useIdentitySession";
import { btnPrimary, field } from "@/lib/brand-ui";

type Props = { roomId: string; messages: ChatMessage[]; historySize: number; onPublicGraph: boolean;
  onComposed: (message: ChatMessage, putOnGun: boolean) => void };
export function RoomTasks(props: Props) {
  const session = useIdentitySession(), see = useSeeAcl(), actor = session ? objectOwner(session) : null;
  // Private drafts and pending submissions cannot cross room or identity changes.
  return <RoomWork key={JSON.stringify([props.roomId, actor])} {...props} actor={actor} see={see} />;
}
function RoomWork({ roomId, messages, historySize, onPublicGraph, onComposed, actor, see }: Props & {
  actor: string | null; see: SeeAclContextValue | null;
}) {
  const [title, setTitle] = useState(""), [kind, setKind] = useState<"task" | "issue">("task");
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const pending = useRef(false), mounted = useRef(true);
  const [, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { mounted.current = true; const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 10_000);
    return () => { mounted.current = false; clearInterval(timer); }; }, []);
  const current = useRef({ actor, roomId, see, onPublicGraph, messages, historySize, onComposed });
  current.current = { actor, roomId, see, onPublicGraph, messages, historySize, onComposed };
  const allowed = !!actor && !!see?.ready && canUseRoomTasks(see.acl, roomId, actor, Math.floor(Date.now() / 1000));
  const tasks = allowed ? roomTasks(messages, roomId).filter(task => task.visibility === "room" || task.owner === actor) : [];
  const full = !Number.isSafeInteger(historySize) || historySize < messages.length || historySize >= 8192;
  async function send(action: TaskAction) {
    if (full || !actor || !see?.ready || pending.current || !canUseRoomTasks(see.acl, roomId, actor, Math.floor(Date.now() / 1000))) return;
    const stillCurrent = () => {
      const held = current.current;
      if (!Number.isSafeInteger(held.historySize) || held.historySize < held.messages.length || held.historySize >= 8192 ||
          !mounted.current || held.actor !== actor || held.roomId !== roomId || held.see !== see || held.onPublicGraph !== onPublicGraph ||
          !canUseRoomTasks(see.acl, roomId, actor, Math.floor(Date.now() / 1000))) return false;
      if (action[0] === "create") return true;
      return roomTasks(held.messages, roomId).some(task => task.id === action[1] && task.head === action[2] && task.owner === actor && (task.visibility === "mine" || onPublicGraph));
    };
    if (!stillCurrent()) { setNotice("This work changed. Try again."); return; }
    pending.current = true; setBusy(true); setNotice("");
    try {
      const message = composeRoomTask(roomId, actor, action);
      if (!message || "denied" in admitComposedChat(see.acl, message, actor)) { setNotice("Could not save this work."); return; }
      await see.persist();
      if (!stillCurrent()) { if (mounted.current) setNotice("Room access or work changed. Nothing was sent."); return; }
      const publish = onPublicGraph && (action[0] === "create" ? action[3] === "room" : roomTasks(current.current.messages, roomId).find(task => task.id === action[1])?.visibility === "room");
      current.current.onComposed(message, publish);
      if (action[0] === "create") setTitle("");
      setNotice(publish ? "Sent to this room." : "Saved in Mine.");
    } catch { if (mounted.current) setNotice("Could not save this work. Try again."); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <section className="mt-4 border border-rule bg-ground p-3" aria-label="Room work">
    <h3 className="text-sm font-semibold text-ink">Tasks and issues</h3>
    <p className="text-xs text-ink-muted">Latest 64. Creators can change status and assignment.</p>
    {!allowed ? <p className="mt-2 text-xs text-ink-muted">{actor ? "Room access is required to view or change work." : "Sign in to work in this room."}</p> : <>
      <p className="mt-2 text-xs text-ink-muted">Private work stays in this page and clears on reload.</p>
      <p className="mt-2 text-xs text-ink-muted">{onPublicGraph ? "Updates appear in this room’s timeline." : "Work stays in Mine. Sharing a room does not publish earlier private work."}</p>
      {full ? <p className="mt-2 text-xs text-ink-muted">This room’s work history is at capacity. New work and updates are unavailable here.</p> : <>
        <div className="mt-3 flex flex-wrap gap-2">
          <label className="text-xs text-ink-muted">Kind<select aria-label="Work kind" className={`ml-2 ${field}`} value={kind} disabled={busy} onChange={e => setKind(e.target.value as "task" | "issue")}>
            <option value="task">Task</option><option value="issue">Issue</option></select></label>
          <label className="min-w-0 flex-1 text-xs text-ink-muted">Title<input className={`mt-1 w-full ${field}`} value={title} maxLength={TASK_TITLE_MAX} disabled={busy} onChange={e => setTitle(e.target.value)} /></label>
          <button type="button" className={btnPrimary} disabled={busy || !title.trim()} onClick={() => void send(["create", kind, title.trim(), onPublicGraph ? "room" : "mine", "open", null])}>Add work</button>
        </div>
        {!tasks.length ? <p className="mt-3 text-xs text-ink-muted">No tasks or issues yet.</p> : <ul className="mt-3 space-y-3">{tasks.map(task =>
          <li key={task.id} className="border-t border-rule pt-2"><p className="text-sm text-ink">{task.kind === "issue" ? "Issue" : "Task"}: {task.title}</p>
            <p className="text-xs text-ink-muted">{task.visibility === "mine" ? "Mine" : "Shared in room"} · {task.status} · {task.assignee ? `Assigned to ${task.assignee}` : "Unassigned"}</p>
            {task.owner === actor && task.visibility === "mine" && onPublicGraph ? <button type="button" className={`mt-2 ${btnPrimary}`} disabled={busy}
              onClick={() => void send(["create", task.kind, task.title, "room", task.status, task.assignee])}>Share a copy</button> : null}
            {task.owner === actor && (task.visibility === "mine" || onPublicGraph) ? <TaskEditor key={task.head} task={task} busy={busy} send={send} /> : null}
          </li>)}</ul>}
      </>}
    </>}
    {notice ? <p className="mt-2 text-xs text-ink-muted" role="status">{notice}</p> : null}
  </section>;
}
function TaskEditor({ task, busy, send }: { task: RoomTask; busy: boolean; send: (action: TaskAction) => Promise<void> }) {
  const [assignee, setAssignee] = useState(task.assignee ?? "");
  return <div className="mt-2 flex flex-wrap items-end gap-2">
    <label className="text-xs text-ink-muted">Status<select aria-label={`Status for ${task.title}`} className={`ml-2 ${field}`} disabled={busy} value={task.status}
      onChange={e => void send(["status", task.id, task.head, e.target.value as TaskStatus])}>{TASK_STATUSES.map(status => <option key={status} value={status}>{status}</option>)}</select></label>
    <label className="min-w-0 text-xs text-ink-muted">Assignee address<input aria-label={`Assignee for ${task.title}`} className={`mt-1 block w-full ${field}`} maxLength={42} disabled={busy} value={assignee} onChange={e => setAssignee(e.target.value)} /></label>
    <button type="button" className={btnPrimary} disabled={busy || assignee.trim() === (task.assignee ?? "")} onClick={() => void send(["assign", task.id, task.head, assignee.trim() || null])}>Set assignee</button>
    <span className="text-xs text-ink-muted">Assignment does not share access.</span>
  </div>;
}
