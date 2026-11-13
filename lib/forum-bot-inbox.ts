/** Private per-bot dispatch bookkeeping. Gun remains the forum record.
 * Callers must verify signed messages and current forum authority before every
 * receive/dispatch operation through the required authorization callback.
 * This module grants no forum access and executes no task or model output.
 */
import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type BotInboxScope = Readonly<{ tenant: string; forum: string; bot: string; principal: string }>;
export type BotInboxTask = Readonly<{
  id: string; message: string; sender: string; handle: string; expires: number; context?: string;
}>;
export type BotInboxCursor = Readonly<{ before: string | null; after: string }>;
export type BotInboxStatus = "pending" | "claimed" | "unknown" | "completed" | "failed" | "cancelled" | "expired";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
function taskValue(value: BotInboxTask): BotInboxTask {
  if (!value || !["expires,handle,id,message,sender", "context,expires,handle,id,message,sender"].includes(Object.keys(value).sort().join()) ||
      !text(value.id, 36) || !uuid.test(value.id) || !text(value.handle, 36) || !uuid.test(value.handle) || !text(value.message, 256) || !text(value.sender, 256) ||
      !Number.isSafeInteger(value.expires) || value.expires <= 0 ||
      ("context" in value && (typeof value.context !== "string" || !/^[0-9a-f]{64}$/.test(value.context)))) throw Error("Invalid bot inbox task");
  return Object.freeze({ id: value.id, message: value.message, sender: value.sender, handle: value.handle, expires: value.expires,
    ...("context" in value ? { context: value.context } : {}) });
}
function privateFile(path: string) {
  if (!isAbsolute(path) || !process.getuid) throw Error("Bot inbox requires a private Unix path");
  const uid = process.getuid(), parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o077))
    throw Error("Bot inbox directory must be private and owned by this user");
  try { closeSync(openSync(path, "wx", 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== uid || (file.mode & 0o077))
    throw Error("Bot inbox file must be private and owned by this user");
}

/** One database belongs to one exact tenant/forum/bot/principal scope. Claims
 * commit before returning. Another connection/process cannot claim the same
 * task, and a restarted process sees prior unfinished claims as unknown.
 * Never delete the database to retry work: that would discard its replay floor.
 * authorize must be synchronous, fail closed, and check current signed authority;
 * dispatch also checks local consent and the task handle's current access.
 */
export function openForumBotInbox(input: {
  path: string; scope: BotInboxScope;
  authorize(task: BotInboxTask, operation: "receive" | "dispatch" | "cancel", scope: BotInboxScope): boolean;
  clock?: () => number; capacity?: number;
}) {
  const { authorize } = input;
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const capacity = input.capacity ?? 4096;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 16384 || typeof authorize !== "function")
    throw Error("Invalid bot inbox policy");
  const scope = Object.freeze({ ...input.scope });
  if (!scope || Object.keys(scope).sort().join() !== "bot,forum,principal,tenant" ||
      !text(scope.bot, 36) || !uuid.test(scope.bot) || !text(scope.tenant, 36) || !uuid.test(scope.tenant) || !text(scope.forum, 256) || !text(scope.principal, 256))
    throw Error("Invalid bot inbox scope");
  const binding = JSON.stringify([scope.tenant, scope.forum, scope.bot, scope.principal]);
  privateFile(input.path);
  const db = new DatabaseSync(input.path, { timeout: 1000, enableForeignKeyConstraints: true });
  const instance = randomUUID();
  function transaction<T>(operation: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    transaction(() => {
      db.exec("CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), scope TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, message TEXT UNIQUE NOT NULL, body TEXT NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL, instance TEXT); CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
      db.prepare("INSERT OR IGNORE INTO binding VALUES (1, ?)").run(binding);
      if (db.prepare("SELECT scope FROM binding WHERE id=1").get()?.scope !== binding) throw Error("Bot inbox scope differs");
    });
  } catch (error) { db.close(); throw error; }
  function now() {
    const at = clock();
    if (!Number.isSafeInteger(at) || at < 0) throw Error("Invalid bot inbox clock");
    return at;
  }
  function allowed(task: BotInboxTask, operation: "receive" | "dispatch" | "cancel") {
    if (authorize(task, operation, scope) !== true) throw Error("Bot inbox authority unavailable");
  }
  return {
    close() { db.close(); },
    cursor(): string | null {
      const row = db.prepare("SELECT value FROM checkpoint WHERE id=1").get();
      return row ? String(row.value) : null;
    },
    receive(value: BotInboxTask, checkpoint?: BotInboxCursor): "stored" | "duplicate" {
      const task = taskValue(value), body = JSON.stringify(task);
      const cursor = checkpoint === undefined ? null : Object.freeze({ ...checkpoint });
      if (cursor && (Object.keys(cursor).sort().join() !== "after,before" ||
          (cursor.before !== null && !text(cursor.before, 2048)) || !text(cursor.after, 2048) || cursor.before === cursor.after))
        throw Error("Invalid bot inbox checkpoint");
      const advance = (duplicate: boolean) => {
        if (!cursor) return;
        const current = db.prepare("SELECT value FROM checkpoint WHERE id=1").get()?.value ?? null;
        if (duplicate && current === cursor.after) return;
        if (current !== cursor.before) throw Error("Bot inbox checkpoint changed");
        db.prepare("INSERT INTO checkpoint VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(cursor.after);
      };
      return transaction(() => {
        allowed(task, "receive");
        const held = db.prepare("SELECT body FROM tasks WHERE id=? OR message=?").all(task.id, task.message);
        if (held.length) {
          if (held.length === 1 && held[0].body === body) { advance(true); return "duplicate"; }
          throw Error("Conflicting bot inbox task");
        }
        const at = now();
        if (task.expires <= at || task.expires > at + 3600) throw Error("Bot task deadline is invalid");
        if (Number(db.prepare("SELECT count(*) AS n FROM tasks").get()?.n) >= capacity) throw Error("Bot inbox is full");
        db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, 'pending', NULL)").run(task.id, task.message, body, task.expires);
        advance(false);
        return "stored";
      });
    },
    claim(id: string): BotInboxTask | null {
      return transaction(() => {
        const row = db.prepare("SELECT body, state, expires FROM tasks WHERE id=?").get(id);
        if (!row || row.state !== "pending") return null;
        if (Number(row.expires) <= now()) {
          db.prepare("UPDATE tasks SET state='expired' WHERE id=?").run(id); return null;
        }
        const task = taskValue(JSON.parse(String(row.body)));
        allowed(task, "dispatch");
        if (task.expires <= now()) {
          db.prepare("UPDATE tasks SET state='expired' WHERE id=?").run(id); return null;
        }
        // No asynchronous work occurs before the claim commit.
        db.prepare("UPDATE tasks SET state='claimed', instance=? WHERE id=? AND state='pending'").run(instance, id);
        return task;
      });
    },
    finish(id: string, state: "completed" | "failed" | "cancelled") {
      if (!["completed", "failed", "cancelled"].includes(state)) throw Error("Invalid terminal state");
      const result = db.prepare("UPDATE tasks SET state=? WHERE id=? AND state='claimed' AND instance=?").run(state, id, instance);
      if (result.changes !== 1) throw Error("Task is not claimed by this worker");
    },
    cancel(id: string) {
      return transaction(() => {
        const row = db.prepare("SELECT body, state FROM tasks WHERE id=?").get(id);
        if (!row) return false;
        allowed(taskValue(JSON.parse(String(row.body))), "cancel");
        if (row.state !== "pending") return false;
        db.prepare("UPDATE tasks SET state='cancelled' WHERE id=?").run(id); return true;
      });
    },
    status(id: string): BotInboxStatus | null {
      const row = db.prepare("SELECT state, instance FROM tasks WHERE id=?").get(id);
      if (!row) return null;
      return row.state === "claimed" && row.instance !== instance ? "unknown" : row.state as BotInboxStatus;
    },
  };
}
