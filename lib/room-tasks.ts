/** Room tasks are projections of admitted chat, with the same persistence and
 * sharing boundary. Callers must supply room/message Check-filtered rows. */
import { getAddress } from "viem";
import { isSeaPubkey } from "./identity/forum-check";
import { signedRoomMessageId, type RoomChatAdmission } from "./room-chat-admission";
import { composeChat, shortChatEntropy, type ChatMessage } from "./chat";
import { checkSee, roomSoul, type SeeAcl } from "./identity/check";

const PREFIX = "s3rch-work:v1:";
export const TASK_TITLE_MAX = 80;
export const TASK_STATUSES = ["open", "doing", "done"] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export type TaskAction = readonly ["create", "task" | "issue", string, "mine" | "room", TaskStatus, string | null] |
  readonly ["status", string, string, TaskStatus] | readonly ["assign", string, string, string | null];
export type RoomTask = Readonly<{ id: string; room: string; owner: string; kind: "task" | "issue";
  title: string; visibility: "mine" | "room"; status: TaskStatus; assignee: string | null; head: string; created: number;
  events: readonly Readonly<{ name: "room.object.created" | "room.object.updated"; messageId: string }>[] }>;
const idOK = (value: unknown): value is string => typeof value === "string" &&
  (/^s3rch:chat:(?:0x[0-9a-fA-F]{40}|[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}):[0-9]{1,16}:[A-Za-z0-9_-]{1,32}$/.test(value) || signedRoomMessageId(value));
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function taskPrincipal(value: string): string { return isSeaPubkey(value) ? value : getAddress(value); }

export function canUseRoomTasks(acl: SeeAcl, room: string, actor: string, now: number): boolean {
  return checkSee(acl, roomSoul(room), actor, now).allowed;
}
export function parseTaskAction(body: unknown): TaskAction | null {
  if (typeof body !== "string" || body.length > 512 || !body.startsWith(PREFIX)) return null;
  try {
    const row: unknown = JSON.parse(body.slice(PREFIX.length));
    if (!Array.isArray(row)) return null;
    if (row.length === 6 && row[0] === "create" && (row[1] === "task" || row[1] === "issue") &&
        typeof row[2] === "string" && row[2].length > 0 && row[2].length <= TASK_TITLE_MAX &&
        (row[3] === "mine" || row[3] === "room") && row[2].trim() === row[2] && !/[\x00-\x1f\x7f]/.test(row[2]) && TASK_STATUSES.includes(row[4]) && (row[5] === null || typeof row[5] === "string"))
      return ["create", row[1], row[2], row[3], row[4], row[5] === null ? null : taskPrincipal(row[5])];
    if (row.length !== 4 || !idOK(row[1]) || !idOK(row[2])) return null;
    if (row[0] === "status" && TASK_STATUSES.includes(row[3])) return ["status", row[1], row[2], row[3]];
    if (row[0] === "assign" && (row[3] === null || typeof row[3] === "string"))
      return ["assign", row[1], row[2], row[3] === null ? null : taskPrincipal(row[3])];
  } catch { /* Unknown or malformed payloads stay ordinary chat text. */ }
  return null;
}
export function composeRoomTask(room: string, author: string, action: TaskAction, nowSeconds?: number): ChatMessage | null {
  const body = PREFIX + JSON.stringify(action);
  if (!parseTaskAction(body)) return null;
  return composeChat({ roomId: room, address: author, body, nowSeconds, entropy: shortChatEntropy(16) });
}
export function roomTaskChatText(body: string): string {
  const action = parseTaskAction(body);
  if (!action) return body;
  if (action[0] === "create") return `Created ${action[1]}: ${action[2]}`;
  if (action[0] === "status") return `Set work status to ${action[3]}.`;
  return action[3] ? `Assigned work to ${action[3]}.` : "Cleared the work assignee.";
}

/** Only the creator edits a task. Assignment is a label, never an access grant.
 * Predecessors prevent stale updates; concurrent siblings use bytewise ID order.
 * Missing parents wait. Bounds prevent untrusted room history from monopolizing
 * a render. This projection does not authenticate raw remote chat records. */
export function roomTasks(messages: readonly ChatMessage[], room: string): RoomTask[] {
  return projectRoomTasks(messages, room, false);
}

/** Production projection: only live signature receipts can supply a creator.
 * Serialization, copying, revocation or identity changes invalidate admission. */
export function admittedRoomTasks(messages: readonly ChatMessage[], room: string, admission: RoomChatAdmission): RoomTask[] {
  return projectRoomTasks(admission.readable(messages, room), room, true);
}

function projectRoomTasks(messages: readonly ChatMessage[], room: string, signed: boolean): RoomTask[] {
  if (messages.length > 8192) return [];
  const rows = new Map<string, { message: ChatMessage; action: TaskAction }>();
  const conflicts = new Set<string>();
  for (const message of messages) {
    if (message.room !== room || !idOK(message.id) || !Number.isSafeInteger(message.ts) || message.ts < 0 ||
        (message.v !== undefined && message.v !== 1)) continue;
    let author: string;
    try { author = taskPrincipal(message.author); } catch { continue; }
    if (signed ? !signedRoomMessageId(message.id) : !message.id.startsWith(`s3rch:chat:${author}:${message.ts}:`)) continue;
    const action = parseTaskAction(message.body);
    if (!action) continue;
    const held = rows.get(message.id);
    if (held && held.message.body !== message.body) conflicts.add(message.id);
    else rows.set(message.id, { message: { ...message, author }, action });
  }
  for (const id of conflicts) rows.delete(id);
  const children = new Map<string, { message: ChatMessage; action: Exclude<TaskAction, readonly ["create", "task" | "issue", string, "mine" | "room", TaskStatus, string | null]> }[]>();
  for (const row of rows.values()) if (row.action[0] !== "create") {
    const key = JSON.stringify([row.action[1], row.action[2]]);
    const held = children.get(key) ?? []; held.push({ message: row.message, action: row.action }); children.set(key, held);
  }
  for (const held of children.values()) held.sort((a, b) => order(a.message.id, b.message.id));
  return [...rows.values()].filter(row => row.action[0] === "create")
    .sort((a, b) => b.message.ts - a.message.ts || order(a.message.id, b.message.id)).slice(0, 64).map(row => {
      const action = row.action as Extract<TaskAction, readonly ["create", "task" | "issue", string, "mine" | "room", TaskStatus, string | null]>;
      const task = { id: row.message.id, room, owner: row.message.author, kind: action[1], title: action[2], visibility: action[3],
        status: action[4] as TaskStatus, assignee: action[5] as string | null, head: row.message.id, created: row.message.ts,
        events: [{ name: "room.object.created" as "room.object.created" | "room.object.updated", messageId: row.message.id }] };
      const seen = new Set([task.id]); let at = task.created;
      for (;;) {
        const next = children.get(JSON.stringify([task.id, task.head]))?.find(child =>
          child.message.author === task.owner && child.message.ts >= at && !seen.has(child.message.id));
        if (!next) break;
        if (next.action[0] === "status") task.status = next.action[3];
        else task.assignee = next.action[3];
        task.head = next.message.id; at = next.message.ts; seen.add(task.head);
        task.events.push({ name: "room.object.updated", messageId: task.head });
      }
      return Object.freeze({ ...task, events: Object.freeze(task.events.map(event => Object.freeze(event))) });
    });
}

export const isRoomTaskBody = (body: string): boolean => body.startsWith("s3rch-work:");
/** Apply to the enclosing chat timeline too, so its text summaries cannot bypass
 * the task panel's access gate or expose a previous identity's Mine overlay. */
export function visibleRoomTaskChat(messages: readonly ChatMessage[], room: string, actor: string | null,
  acl: SeeAcl | null | undefined, now: number): ChatMessage[] {
  const ids = new Set<string>();
  if (actor && acl && canUseRoomTasks(acl, room, actor, now)) {
    for (const task of roomTasks(messages, room)) if (task.visibility === "room" || task.owner === actor)
      for (const event of task.events) ids.add(event.messageId);
  }
  return messages.filter(message => !isRoomTaskBody(message.body) || ids.has(message.id));
}
/** Use at every Gun publication boundary, including the existing room-share
 * replay loop. Merely sharing a room cannot publish its private task history. */
export function roomTaskPublicationIds(messages: readonly ChatMessage[], room: string, actor: string,
  acl: SeeAcl, now: number): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!canUseRoomTasks(acl, room, actor, now)) return ids;
  for (const task of roomTasks(messages, room)) if (task.visibility === "room" && task.owner === actor)
    for (const event of task.events) ids.add(event.messageId);
  return ids;
}
