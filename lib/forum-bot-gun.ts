import type { ForumAuthorityGraph } from "./identity/forum-authority";
import type { SignedBotStatement } from "./forum-bot-channel";
import type { createForumBotWorker } from "./forum-bot-worker";
import { forumStatementFromNode } from "./forum-squad";
import { parseBotMessage } from "./forum-bot-protocol";
import { sameEmbeddedPrincipal } from "./identity/forum-check";
import { readForumSignature, signatureOf } from "./forum-sign";
/** Watches only individually authorized statement objects from the provisioned
 * authority source. It never scans a global feed or treats Gun as complete.
 * Reconnect replays retained statements; the inbox, not Gun ordering, deduplicates.
 */
export function createForumBotGunTransport(input: {
  gun: any; forum: string; principal: string; authority: ForumAuthorityGraph;
  principals: readonly string[]; worker: ReturnType<typeof createForumBotWorker>; clock?: () => number;
}) {
  const { gun, forum, principal, authority, worker } = input, principals = [...input.principals];
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const watches = new Map<string, any>(), incoming = new Map<string, unknown>();
  const tasks = new Map<string, { envelope: SignedBotStatement; parent: string | null }>(), delivered = new Set<string>();
  let closed = false;
  return Object.freeze({
    async tick() {
      if (closed) return;
      const at = clock();
      if (!authority.checkForumSee(forum, principal, at).allowed) {
        for (const watch of watches.values()) watch.off?.(); watches.clear(); incoming.clear(); return;
      }
      const ids = new Set(principals.flatMap(p => authority.ownedObjects(p)).filter(id => id.startsWith("stmt_") &&
        authority.checkForumSee(id, principal, at).allowed));
      if (ids.size > 512) throw Error("Bot statement watch capacity reached");
      for (const [id, watch] of watches) if (!ids.has(id)) { watch.off?.(); watches.delete(id); incoming.delete(id); }
      for (const id of ids) if (!watches.has(id)) {
        watches.set(id, {});
        const watch = gun.get("s3rch").get("items").get(id).on((data: unknown) => {
          if (closed || !data || !watches.has(id)) return;
          // Bound records before retaining untrusted transport input.
          try { const text = JSON.stringify(data); if (text.length <= 65536) incoming.set(id, JSON.parse(text)); } catch {}
        });
        watches.set(id, watch);
      }
      const events: [string, SignedBotStatement][] = [];
      for (const [id, raw] of [...incoming]) {
        if (delivered.has(id)) { incoming.delete(id); continue; }
        const hint = forumStatementFromNode(raw, forum), sig = signatureOf(raw);
        if (!hint || hint.id !== id || !sig) { incoming.delete(id); continue; }
        const key = authority.writerKey(hint.author, hint.ts, clock()); if (!key) continue;
        const item = forumStatementFromNode(await readForumSignature(sig, key), forum), message = parseBotMessage(item?.body);
        if (!item || item.id !== id || item.author !== hint.author || item.ts !== hint.ts || !message ||
            !sameEmbeddedPrincipal(item.author, id) || authority.writerKey(item.author, item.ts, clock()) !== key ||
            !authority.checkDirectSee(id, item.author, clock()).allowed || !authority.checkPost(id, item.author, clock()).allowed ||
            !authority.checkForumSee(id, principal, clock()).allowed) { incoming.delete(id); continue; }
        const envelope = Object.freeze({ id, author: item.author, issuedAt: item.ts, signature: sig });
        if (message[0] === "task") {
          const old = tasks.get(message[2]);
          if (old && old.envelope.id !== id) throw Error("Conflicting forum task identity");
          if (!old && tasks.size >= 4096) throw Error("Bot task transport capacity reached");
          tasks.set(message[2], { envelope, parent: message[6] });
        } else {
          events.push([id, envelope]);
        }
      }
      for (const [taskId, entry] of tasks) {
        if (delivered.has(entry.envelope.id)) continue;
        const chain: SignedBotStatement[] = [], seen = new Set<string>(); let next: string | null = taskId;
        while (next && chain.length <= 5 && !seen.has(next)) {
          seen.add(next); const link = tasks.get(next); if (!link) break;
          chain.unshift(link.envelope); next = link.parent;
        }
        if (next || chain.length > 5) continue;
        try { await worker.deliver(chain); delivered.add(entry.envelope.id); incoming.delete(entry.envelope.id); } catch { /* Not this bot, or authority is not currently available. */ }
      }
      for (const [id, envelope] of events) {
        try { await worker.event(envelope); delivered.add(id); incoming.delete(id); } catch { /* Retry after task proofs arrive. */ }
      }
      if (delivered.size > 4096) throw Error("Bot delivery capacity reached");
    },
    async put(node: Record<string, unknown>) {
      if (closed || typeof node.id !== "string") throw Error("Bot transport unavailable");
      const id = node.id;
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("Bot publication acknowledgement unavailable")), 1500);
        gun.get("s3rch").get("items").get(id).put(node, (ack: any) => {
          clearTimeout(timer); if (ack?.err) reject(Error("Bot publication refused")); else resolve();
        });
      });
    },
    close() { closed = true; for (const watch of watches.values()) watch.off?.(); watches.clear(); incoming.clear(); tasks.clear(); },
  });
}
