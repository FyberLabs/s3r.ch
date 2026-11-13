import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BotMessage } from "./forum-bot-protocol";
import { encodeBotMessage } from "./forum-bot-protocol";
import type { BotInboxScope } from "./forum-bot-inbox";
import { privateBotDirectory } from "./forum-bot-local-access";
import { seaToPrincipalKey } from "./identity/forum-check";
export function openForumBotOutbox(path: string, binding: BotInboxScope) {
  const scope = Object.freeze({ tenant: binding.tenant, forum: binding.forum, bot: binding.bot, principal: binding.principal });
  privateBotDirectory(dirname(path));
  try { closeSync(openSync(path, "wx", 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077)) throw Error("Private outbox required");
  const db = new DatabaseSync(path, { timeout: 1000 });
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS reports (digest TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, body TEXT NOT NULL, node TEXT, sent INTEGER NOT NULL DEFAULT 0)");
    db.prepare("INSERT OR IGNORE INTO binding VALUES (1, ?)").run(JSON.stringify(scope));
    if (db.prepare("SELECT value FROM binding WHERE id=1").get()?.value !== JSON.stringify(scope)) throw Error("Outbox scope differs");
  } catch (error) { db.close(); throw error; }
  return Object.freeze({
    close() { db.close(); },
    enqueue(message: BotMessage) {
      if (message[1] !== scope.tenant || !["approval", "ack", "progress", "result"].includes(message[0])) throw Error("Invalid bot report");
      const body = encodeBotMessage(message), digest = createHash("sha256").update(body).digest("hex");
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!db.prepare("SELECT id FROM reports WHERE digest=?").get(digest)) {
          if (Number(db.prepare("SELECT COUNT(*) AS n FROM reports").get()?.n) >= 4096) throw Error("Outbox capacity reached");
          db.prepare("INSERT INTO reports(digest,id,body) VALUES(?,?,?)").run(digest,
            `stmt_${seaToPrincipalKey(scope.principal)}_${randomUUID().replaceAll("-", "")}`, body);
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    next(): { id: string; body: string; node: Record<string, unknown> | null } | null {
      const row = db.prepare("SELECT id,body,node FROM reports WHERE sent=0 ORDER BY rowid LIMIT 1").get();
      return row ? { id: String(row.id), body: String(row.body), node: row.node ? JSON.parse(String(row.node)) : null } : null;
    },
    stage(id: string, node: Record<string, unknown>) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare("SELECT body,node FROM reports WHERE id=? AND sent=0").get(id), text = JSON.stringify(node);
        if (!row || node.id !== id || node.author !== scope.principal || node.body !== row.body || typeof node.sig !== "string" || text.length > 65536)
          throw Error("Outbox statement differs");
        if (row.node !== null && row.node !== text) throw Error("Outbox statement already signed");
        db.prepare("UPDATE reports SET node=? WHERE id=? AND node IS NULL").run(text, id);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    sent(id: string) { if (db.prepare("UPDATE reports SET sent=1 WHERE id=? AND node IS NOT NULL").run(id).changes !== 1) throw Error("Outbox statement unavailable"); },
  });
}
