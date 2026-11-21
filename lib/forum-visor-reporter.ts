import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { p256 } from "@noble/curves/nist.js";
import { createForumAuthority, type ForumAuthorityConfig } from "./identity/forum-authority";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { isForumObjectId, isSeaPubkey } from "./identity/forum-check";
import type { SeaPair } from "./identity/sea";
import { createHttpForumAuthorityReader } from "./forum-authority-http";
import { createBotAuthorityRefresh, currentBotReportReaders } from "./forum-bot-runtime";
import { privateBotDirectory, readPrivateBotFile } from "./forum-bot-local-access";
import { createBotSession } from "./forum-bot-session";
import { buildForumStatement } from "./forum-squad";
import { signForumRecord } from "./forum-sign";
import { toGunNode } from "./feed-types";
import { encodeBotMessage } from "./forum-bot-protocol";
import { readBoundedIdentityJson } from "./identity/bounded-json";

const validId = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";

const notes = {
  completed: "Conductor completed the task.",
  failed: "Conductor reported that the task failed.",
} as const;

type Report = {
  tenant: string; botId: string; assignmentId: string; sessionId: string; taskId: string;
  deliveryId: string; forumId: string; principal: string; status: keyof typeof notes;
};
type Config = {
  version: 1; tenant: string; botId: string; forumId: string; principal: string; owner: string;
  origin: string; peer: string; pairFile: string; stateDirectory: string; readers: string[];
  authority: ForumAuthorityConfig;
};

export function parseVisorForumReport(value: unknown): Report | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Partial<Report>;
  if (Object.keys(r).length !== 9 || !validId(r.tenant) || !validId(r.botId) || !validId(r.assignmentId) ||
      !validId(r.sessionId) || !validId(r.taskId) || !validId(r.deliveryId) ||
      typeof r.forumId !== "string" || !isForumObjectId(r.forumId, "forum") ||
      typeof r.principal !== "string" || !isSeaPubkey(r.principal) ||
      (r.status !== "completed" && r.status !== "failed")) return null;
  return r as Report;
}

export function openVisorForumReporter(configFile: string) {
  const c = JSON.parse(readPrivateBotFile(configFile, 24576).toString("utf8")) as Config;
  if (!c || c.version !== 1 || !validId(c.tenant) || !validId(c.botId) ||
      !isForumObjectId(c.forumId, "forum") || !isSeaPubkey(c.owner) || !isSeaPubkey(c.principal) ||
      !Array.isArray(c.readers) || c.readers.length > 63 || !c.readers.every(isSeaPubkey)) {
    throw Error("Invalid Visor forum reporter configuration");
  }
  privateBotDirectory(c.stateDirectory);
  const pair = JSON.parse(readPrivateBotFile(c.pairFile, 8192).toString("utf8")) as SeaPair;
  if (pair.pub !== c.principal || typeof pair.priv !== "string") throw Error("Forum signer binding differs");
  const peer = new URL(c.peer);
  if (peer.protocol !== "https:" || peer.username || peer.password || peer.search || peer.hash) {
    throw Error("An explicit HTTPS Gun peer is required");
  }
  const session = createBotSession({ origin: c.origin, pair });
  const authority = createForumAuthority(c.authority);
  const reader = createHttpForumAuthorityReader({ endpoint: "/api/squad/pilot/authority",
    squad: { forumId: c.forumId, owner: c.owner, label: "Visor forum" }, fetch: session.fetch });
  const refresh = createBotAuthorityRefresh({ authority, reader, signIn: session.signIn,
    forum: c.forumId, owner: c.owner, principal: c.principal, key: pair.pub });
  const Gun = createRequire(import.meta.url)("gun");
  const gun = Gun({ peers: [peer.href], radisk: false, localStorage: false, axe: false });

  const db = new DatabaseSync(join(c.stateDirectory, "visor-reports.sqlite"), { timeout: 1000 });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS reports (delivery TEXT PRIMARY KEY, binding TEXT NOT NULL, envelope TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0)");
  const signRow = (kind: AuthorityKind, fields: object) => {
    const record = { ...fields, sig: "pending" };
    const parsed = parseForumAuthority(kind, record);
    if (!parsed) throw Error("Invalid forum report grant");
    record.sig = Buffer.from(p256.sign(parsed.bytes, Buffer.from(pair.priv, "base64url"),
      { prehash: true, format: "compact" })).toString("base64url");
    return { kind, soul: parsed.soul, record };
  };
  let busy = false;

  return {
    socket: join(c.stateDirectory, "reporter.sock"),
    async report(value: unknown, stopped: AbortSignal) {
      const r = parseVisorForumReport(value);
      if (busy || !r || r.tenant !== c.tenant || r.forumId !== c.forumId ||
          r.botId !== c.botId || r.principal !== c.principal) throw Error("Forum report binding differs");
      busy = true;
      try {
        const binding = JSON.stringify([r.tenant, r.forumId, r.botId, r.assignmentId, r.sessionId, r.taskId, r.status]);
        const prior = db.prepare("SELECT binding,envelope,sent FROM reports WHERE delivery=?").get(r.deliveryId);
        if (prior && prior.binding !== binding) throw Error("Forum report delivery changed");
        if (prior?.sent === 1) return;
        stopped.throwIfAborted();
        if (!await refresh(true)) throw Error("Forum authority unavailable");
        const at = Math.floor(Date.now() / 1000);
        let envelope = prior ? JSON.parse(String(prior.envelope)) : null;
        if (!envelope) {
          const count = db.prepare("SELECT COUNT(*) AS total FROM reports").get();
          if (Number(count?.total) >= 4096) throw Error("Forum report capacity reached");
          const item = buildForumStatement({ forumId: c.forumId, author: c.principal, now: at,
            entropy: createHash("sha256").update(JSON.stringify([binding, r.deliveryId])).digest("hex").slice(0, 32),
            body: encodeBotMessage(["update", c.tenant, r.taskId, notes[r.status]]) });
          if (!item) throw Error("Invalid outgoing forum report");
          const data = toGunNode(item), sig = await signForumRecord(data, pair);
          if (!sig) throw Error("Forum report signing failed");
          const rows = [signRow("object", { object: item.id, owner: c.principal, issuedAt: at }),
            ...currentBotReportReaders(authority.graph, c.forumId, c.principal, [...new Set(c.readers)], at)
              .map(accessor => signRow("see", { object: item.id, owner: c.principal, accessor, from: at,
                until: at + 3600, stated: 1, hamState: at, issuedAt: at }))];
          envelope = { node: { ...data, sig }, rows, update: { botId: r.botId, assignmentId: r.assignmentId,
            sessionId: r.sessionId, taskId: r.taskId, deliveryId: r.deliveryId, sequence: 1, signature: sig } };
          db.prepare("INSERT INTO reports(delivery,binding,envelope) VALUES(?,?,?)")
            .run(r.deliveryId, binding, JSON.stringify(envelope));
        }

        stopped.throwIfAborted();
        const signal = AbortSignal.any([stopped, AbortSignal.timeout(1500)]);
        const response = await session.fetch("/api/squad/pilot/plane/update", { method: "POST", signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: 1, forumId: c.forumId, owner: c.owner, evaluatedAt: at,
            rows: envelope.rows, update: envelope.update }) });
        if (!response.ok) {
          await response.body?.cancel();
          throw Error("Forum report admission unavailable");
        }
        const outcome = await readBoundedIdentityJson(response, 1024, signal) as { ok?: unknown } | null;
        if (outcome?.ok !== true) throw Error("Forum report admission refused");
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("Forum report acknowledgment unavailable")), 1000);
          gun.get("s3rch").get("items").get(envelope.node.id).put(envelope.node, (ack: { err?: unknown }) => {
            clearTimeout(timer);
            if (ack?.err) reject(Error("Forum report transport refused")); else resolve();
          });
        });
        db.prepare("UPDATE reports SET sent=1 WHERE delivery=?").run(r.deliveryId);
      } finally {
        busy = false;
      }
    },
  };
}
