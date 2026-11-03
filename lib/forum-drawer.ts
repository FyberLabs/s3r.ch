import type { FeedGun } from "../components/GunPeerProvider";
import type { ForumAuthorityGraph } from "./identity/forum-authority";
import { checkForumChildWrite } from "./identity/forum-child-write";
import { isForumObjectId, isSeaPubkey, sameEmbeddedPrincipal, forumAgentSoul,
  forumSubtaskSoul, forumUpdateSoul, forumArtifactSoul } from "./identity/forum-check";
import { recoveryInteger, recoveryObject } from "./identity/forum-recovery-records";
import { forumSoulNode } from "./forum-transport";
import { publishForumAuthorized } from "./forum-authorized-publish";
import { createForumPublicationFence } from "./forum-publication-fence";

export type DrawerKind = "subtask" | "update" | "prompt" | "artifact";
export type DrawerRecord = Readonly<{
  domain: "s3rch-forum-child-v1"; kind: DrawerKind; forumId: string; agent: string;
  id: string; writer: string; rev: number; issuedAt: number; stated: 0 | 1;
  body: string; state: "" | "pending" | "running" | "done" | "failed"; target: string;
}>;
const fields = ["domain", "kind", "forumId", "agent", "id", "writer", "rev", "issuedAt", "stated", "body", "state", "target"];
export const DRAWER_LIMIT = 128, DRAWER_PENDING_MS = 30_000;
export function drawerSoul(r: DrawerRecord): string {
  return (r.kind === "subtask" ? forumSubtaskSoul : r.kind === "artifact" ? forumArtifactSoul : forumUpdateSoul)(r.forumId, r.agent, r.id);
}
/** Closed signed payload schema. Transport metadata is never part of this row. */
export function parseDrawerRecord(input: unknown): DrawerRecord | null {
  const r = recoveryObject(input);
  if (!r || Object.keys(r).length !== fields.length || fields.some(k => !Object.hasOwn(r, k)) ||
      r.domain !== "s3rch-forum-child-v1" || (typeof r.kind !== "string" || !["subtask", "update", "prompt", "artifact"].includes(r.kind)) ||
      typeof r.forumId !== "string" || !isForumObjectId(r.forumId, "forum") ||
      typeof r.agent !== "string" || !isSeaPubkey(r.agent) || typeof r.writer !== "string" || !isSeaPubkey(r.writer) ||
      typeof r.id !== "string" || !isForumObjectId(r.id, r.kind as string) || !sameEmbeddedPrincipal(r.agent, r.id) ||
      !recoveryInteger(r.rev) || !recoveryInteger(r.issuedAt) || (r.stated !== 0 && r.stated !== 1) ||
      typeof r.body !== "string" || !r.body.trim() || r.body.length > 2048 ||
      typeof r.target !== "string" || (r.kind === "artifact" ? !isForumObjectId(r.target) : r.target !== "") ||
      (r.kind === "subtask" ? (typeof r.state !== "string" || !["pending", "running", "done", "failed"].includes(r.state)) : r.state !== "")) return null;
  return Object.freeze(Object.fromEntries(fields.map(k => [k, r[k]]))) as DrawerRecord;
}
export type DrawerAuthority = {
  graph: ForumAuthorityGraph;
  subscribe(fn: () => void): () => void;
};
type Held = { row: DrawerRecord; key: string; sig: string };
/** One open drawer's subscriptions, replay floors and publication boundary.
 * No persisted cache is accepted as evidence. Floors survive reconnect within
 * this controller. At capacity, refuse new IDs instead of forgetting deletions.
 */
export function createForumDrawer(input: {
  forum: string; agent: string; authority: DrawerAuthority;
  viewer: () => string | null; active: () => boolean;
  verify: (sig: string, key: string) => Promise<unknown>;
  clock?: () => number; millis?: () => number;
}) {
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const publicationFence = createForumPublicationFence();
  const millis = input.millis ?? Date.now;
  const held = new Map<string, Held>();
  const seen = new Map<string, string>();
  const pending = new Map<string, { id: string; sig: string; writer: string; at: number; path: string; tail: boolean }>();
  const waiting = new Set<string>(), checking = new Set<string>();
  const hasPending = (id: string) => pending.has(id + ":main") || pending.has(id + ":tail");
  const knownIds = () => new Set([...held.keys(), ...[...pending.values()].map(p => p.id)]).size;
  const listeners = new Set<() => void>();
  let gun: FeedGun | null = null, epoch = 0, disposed = false, inflight = 0;
  const offs: { off?: () => void }[] = [], tails = new Map<string, { off?: () => void }>();
  const notify = () => { for (const f of listeners) f(); };
  const nowKey = (r: DrawerRecord) => input.authority.graph.writerKey(r.writer, r.issuedAt, clock());
  function authorized(r: DrawerRecord) {
    const g = input.authority.graph, now = clock();
    return !disposed && input.active() && r.forumId === input.forum && r.agent === input.agent &&
      r.issuedAt <= now && checkForumChildWrite(g, input.forum, input.agent, r.id, r.writer, now).allowed &&
      (!r.target || g.checkDirectSee(r.target, r.writer, now).allowed);
  }
  function readable(r: DrawerRecord) {
    const viewer = input.viewer(), g = input.authority.graph, now = clock();
    return !!viewer && authorized(r) && g.checkDirectSee(r.id, viewer, now).allowed &&
      (!r.target || g.checkDirectSee(r.target, viewer, now).allowed);
  }
  function wins(row: DrawerRecord, prev: Held | undefined) {
    return !prev || row.rev > prev.row.rev || (row.rev === prev.row.rev &&
      (row.stated < prev.row.stated || (row.stated === prev.row.stated && JSON.stringify(row) < JSON.stringify(prev.row))));
  }
  function watchTail(id: string, path: string) {
    if (!gun || tails.has(id) || tails.size >= DRAWER_LIMIT) return;
    tails.set(id, {}); // Gun may deliver a cached value synchronously from on().
    const off = forumSoulNode(gun, path)?.get("remove").on(data => { void receive(data, id, path, true); });
    if (off) tails.set(id, off);
  }
  function watchAdmittedTails() {
    // The main row may never have arrived (e.g. a lost second removal put).
    // Signed object admission also permits discovering the independent tail.
    if (!gun || !input.active()) return;
    for (const id of input.authority.graph.ownedObjects(input.agent)) {
      const builder = isForumObjectId(id, "subtask") ? forumSubtaskSoul :
        isForumObjectId(id, "artifact") ? forumArtifactSoul :
          isForumObjectId(id, "update") || isForumObjectId(id, "prompt") ? forumUpdateSoul : null;
      if (builder) watchTail(id, builder(input.forum, input.agent, id));
    }
  }
  async function receive(data: unknown, id: string, path: string, tail = false): Promise<boolean> {
    const envelope = recoveryObject(data);
    // Only bounded scalar hints are used before SEA verification.
    if (disposed || !input.active() || !envelope || typeof envelope.sig !== "string" ||
        !envelope.sig.startsWith("SEA") || envelope.sig.length > 32768 ||
        typeof envelope.writer !== "string" || !isSeaPubkey(envelope.writer) ||
        !isForumObjectId(id) || !sameEmbeddedPrincipal(input.agent, id)) return false;
    if (!held.has(id) && !hasPending(id) && knownIds() >= DRAWER_LIMIT) return false;
    const sig = envelope.sig, writer = envelope.writer, token = epoch;
    const slot = id + (tail ? ":tail" : ":main"), work = token + ":" + slot + ":" + sig;
    // Missing history/grants may arrive after the row. Keep only a bounded hint;
    // it never becomes visible without passing this entire verification path.
    pending.set(slot, { id, sig, writer, path, tail, at: pending.get(slot)?.at ?? millis() });
    watchTail(id, path);
    const key = input.authority.graph.writerKey(writer, clock(), clock());
    if (!key) return false;
    if (checking.has(work)) return false;
    if (inflight >= 32) { waiting.add(slot); return false; }
    waiting.delete(slot); checking.add(work); inflight++;
    try {
      const row = parseDrawerRecord(await input.verify(sig, key));
      if (disposed || epoch !== token) return false;
      if (!row || row.writer !== writer || row.id !== id || drawerSoul(row) !== path || (tail && row.stated !== 0)) {
        if (pending.get(slot)?.sig === sig) pending.delete(slot);
        return false;
      }
      if (nowKey(row) !== key || !authorized(row)) return false;
      if (!held.has(id) && held.size >= DRAWER_LIMIT) return false;
      if (wins(row, held.get(id))) held.set(id, { row, sig, key });
      const winner = held.get(id);
      // SEA may produce different valid signatures for identical content.
      // Reverification of the same winning payload is fresh evidence too.
      if (winner && winner.key === key && JSON.stringify(winner.row) === JSON.stringify(row)) seen.set(id, winner.sig);
      if (pending.get(slot)?.sig === sig) pending.delete(slot);
      notify();
      return true;
    } catch {
      if (epoch === token && pending.get(slot)?.sig === sig) pending.delete(slot);
      return false;
    } finally {
      inflight--; checking.delete(work);
      if (epoch === token && !hasPending(id) && !held.has(id)) { tails.get(id)?.off?.(); tails.delete(id); }
      // Retry queued channels, not denied proofs. Those await a fresh authority
      // notification or the periodic refresh, avoiding a busy verification loop.
      for (const queued of waiting) {
        if (inflight >= 32) break;
        waiting.delete(queued);
        const p = pending.get(queued);
        if (p) void receive({ sig: p.sig, writer: p.writer }, p.id, p.path, p.tail);
      }
    }
  }
  function refresh() {
    if (disposed) return;
    notify(); // Immediately hide rows whose current authority or key disappeared.
    watchAdmittedTails();
    for (const [slot, p] of pending) {
      if (millis() - p.at >= DRAWER_PENDING_MS) {
        pending.delete(slot); waiting.delete(slot);
        if (!held.has(p.id) && !hasPending(p.id)) { tails.get(p.id)?.off?.(); tails.delete(p.id); }
        continue;
      }
      void receive({ sig: p.sig, writer: p.writer }, p.id, p.path, p.tail);
    }
  }
  const stopAuthority = input.authority.subscribe(refresh);
  function disconnect() {
    epoch++; gun = null;
    for (const off of offs.splice(0)) off.off?.();
    for (const off of tails.values()) off.off?.();
    tails.clear(); pending.clear(); waiting.clear(); seen.clear(); notify();
  }
  return {
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    rows(): readonly DrawerRecord[] {
      if (!gun || !input.active() || disposed) return [];
      return [...held.values()].filter(h => seen.get(h.row.id) === h.sig && h.row.stated === 1 && readable(h.row) && nowKey(h.row) === h.key)
        .map(h => h.row).sort((a, b) => a.issuedAt - b.issuedAt || a.id.localeCompare(b.id));
    },
    atCapacity() { return held.size >= DRAWER_LIMIT; },
    revision(id: string) { return held.get(id)?.row.rev ?? -1; },
    refresh,
    connect(next: FeedGun) {
      disconnect(); if (disposed || !isForumObjectId(input.forum, "forum") || !isSeaPubkey(input.agent)) return;
      gun = next;
      const root = forumSoulNode(next, forumAgentSoul(input.forum, input.agent))!;
      for (const name of ["subtasks", "updates", "artifacts"]) offs.push(root.get(name).map().on((data, id) => {
        if (typeof id !== "string" || !isForumObjectId(id) || !sameEmbeddedPrincipal(input.agent, id)) return;
        const path = forumAgentSoul(input.forum, input.agent) + "/" + name + "/" + id;
        void receive(data, id, path);
      }));
      for (const [id, h] of held) watchTail(id, drawerSoul(h.row));
      watchAdmittedTails();
      notify();
    },
    disconnect,
    // Local signing/dispatch drain; not a durable cancellation or worker receipt.
    // Reconnect cannot reopen this instance after quiescence.
    quiescePublications: () => publicationFence.close(),
    async publish(raw: unknown, signing: { key: string; sign: (r: DrawerRecord) => Promise<string | null> }) {
      const row = parseDrawerRecord(raw), token = epoch;
      if (!row) return "denied" as const;
      const allowed = () => {
        const previous = held.get(row.id)?.row;
        return !!gun && token === epoch && input.viewer() === row.writer && (held.has(row.id) || held.size < DRAWER_LIMIT) && authorized(row) && nowKey(row) === signing.key &&
          (!previous || row.rev > previous.rev || (row.stated === 0 && row.rev === previous.rev && JSON.stringify(row) === JSON.stringify(previous)));
      };
      const put = (path: string) => publishForumAuthorized({ record: row, authorized: allowed, fence: publicationFence,
        sign: signing.sign, put: value => { const node = gun && forumSoulNode(gun, path); if (!node) return false; node.put(value); return true; } });
      // Publish the separate removal tail first; a lost main-row put may
      // not erase the independently subscribed tombstone.
      if (!row.stated) { const result = await put(drawerSoul(row) + "/remove"); if (result !== "signed") return result; }
      return put(drawerSoul(row));
    },
    dispose() { disposed = true; void publicationFence.close(); disconnect(); stopAuthority(); held.clear(); listeners.clear(); },
  };
}
