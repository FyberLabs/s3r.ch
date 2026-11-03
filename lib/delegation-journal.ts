import { parseDrawerRecord, type DrawerRecord } from "./forum-drawer";
import type { InventoryStore } from "./delegation-inventory";
import type { AssignmentMutationScope, AssignmentReceipt } from "./delegation-publish";
import type { ForumAuthoritySnapshot } from "./identity/forum-authority";
import { parseForumAuthority } from "./identity/forum-authority-records";
import { isForumObjectId, isSeaPubkey } from "./identity/forum-check";

// Two direct cancellations plus at most one effective group cancellation per destination.
export const MAX_ASSIGNMENT_DESTINATIONS = 64;
type Row = ForumAuthoritySnapshot["rows"][number];
type Operation = { cancellationDigest?: string; grantDigest?: string; id: string; previous: string; replacement: string; phase: "cancellations" | "replacement" | "complete" | "aborted" };
export type AssignmentJournalState = Readonly<{
  version: 1; revision: number; forum: string; owner: string; assignee: string;
  destinations: readonly string[]; rows: readonly Row[]; operation: Operation | null;
  children: Readonly<Record<string, { record: DrawerRecord; signature: string }>>;
  receipts: Readonly<Record<string, AssignmentReceipt>>; usedOperations: readonly string[];
}>;
const idOK = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
const canonical = (row: Row) => { const p = parseForumAuthority(row.kind, row.record);
  if (!p || p.soul !== row.soul) throw Error("invalid authority row"); return JSON.stringify([p.kind, p.soul, p.row]); };
function parse(text: string): AssignmentJournalState {
  if (Buffer.byteLength(text) > 2_097_152) throw Error("assignment journal capacity");
  const s = JSON.parse(text) as AssignmentJournalState;
  if (!s || s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 ||
      !isForumObjectId(s.forum, "forum") || !isSeaPubkey(s.owner) || !isSeaPubkey(s.assignee) || s.assignee === s.owner ||
      !Array.isArray(s.destinations) || s.destinations.length > MAX_ASSIGNMENT_DESTINATIONS || new Set(s.destinations).size !== s.destinations.length ||
      s.destinations.some(d => !isForumObjectId(d)) || !Array.isArray(s.rows) || s.rows.length > 1024 ||
      !Array.isArray(s.usedOperations) || s.usedOperations.length > 256 || s.usedOperations.some(id => !idOK(id)) ||
      new Set(s.usedOperations).size !== s.usedOperations.length || !s.children || typeof s.children !== "object" || Array.isArray(s.children) || Object.keys(s.children).length > 256 || !s.receipts || typeof s.receipts !== "object" || Array.isArray(s.receipts) || Object.keys(s.receipts).length > 256)
    throw Error("invalid assignment journal");
  const exactKeys = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
  if (!exactKeys(s, ["version", "revision", "forum", "owner", "assignee", "destinations", "rows", "operation", "children", "receipts", "usedOperations"]) ||
      !("operation" in s) || (s.operation !== null && (typeof s.operation !== "object" || Array.isArray(s.operation))) || !s.destinations.length) throw Error("invalid assignment schema");
  s.rows.forEach(row => {
    canonical(row);
    const parsed = parseForumAuthority(row.kind, row.record)!;
    if ("object" in parsed.row && typeof parsed.row.object === "string" && !s.destinations.includes(parsed.row.object) &&
        !(parsed.kind === "object" && parsed.row.object === s.forum))
      throw Error("authority destination missing from inventory");
  });
  for (const [id, value] of Object.entries(s.children)) if (!value || !parseDrawerRecord(value.record) || value.record.id !== id ||
    !s.destinations.includes(id) || value.record.forumId !== s.forum || value.record.agent !== s.owner ||
    typeof value.signature !== "string" || !value.signature || value.signature.length > 32768) throw Error("invalid saved child");
  if (s.operation && (!idOK(s.operation.id) || !isSeaPubkey(s.operation.previous) || !isSeaPubkey(s.operation.replacement) ||
      s.operation.previous === s.operation.replacement || !["cancellations", "replacement", "complete", "aborted"].includes(s.operation.phase)))
    throw Error("invalid assignment operation");
  if (s.operation && (!exactKeys(s.operation, ["id", "previous", "replacement", "phase", "cancellationDigest", "grantDigest"]) ||
      !s.usedOperations.includes(s.operation.id) ||
      s.assignee !== (s.operation.phase === "complete" ? s.operation.replacement : s.operation.previous) ||
      (s.operation.grantDigest && !s.operation.cancellationDigest) ||
      (["replacement", "complete"].includes(s.operation.phase) && (!s.operation.cancellationDigest || !s.operation.grantDigest)) ||
      (s.operation.phase === "complete" && s.receipts[s.operation.id]?.replacement !== s.operation.replacement) ||
      (s.operation.phase !== "complete" && s.receipts[s.operation.id]))) throw Error("inconsistent assignment operation");
  for (const digest of [s.operation?.cancellationDigest, s.operation?.grantDigest])
    if (digest !== undefined && !/^[0-9a-f]{64}$/.test(digest)) throw Error("invalid operation digest");
  for (const [id, receipt] of Object.entries(s.receipts)) if (!receipt || !exactKeys(receipt, ["operationId", "replacement", "revision", "evaluatedAt"]) || !s.usedOperations.includes(id) || !idOK(id) || receipt.operationId !== id || !isSeaPubkey(receipt.replacement) ||
    !Number.isSafeInteger(receipt.evaluatedAt) || receipt.evaluatedAt < 0 || !/^[1-9][0-9]*$/.test(receipt.revision) || !Number.isSafeInteger(Number(receipt.revision)) || Number(receipt.revision) > s.revision) throw Error("invalid assignment receipt");
  return s;
}
/** One authoritative CAS journal owns assignment, inventory and ACL publication.
 * This is NOT a cache of arbitrary Gun puts. All authority/inventory writers must
 * use the same journal. The deployment must independently authenticate actor and
 * verify signed provisioning/ordinary authority mutations before calling those
 * administration methods. No user-controlled namespace or actor is accepted at
 * the HTTP boundary. Missing state is never initialized during normal use.
 */
export function createAssignmentJournal(store: InventoryStore, clock = () => Math.floor(Date.now() / 1000)) {
  async function read() {
    const value = await store.read();
    if (!value || !value.etag || value.etag === "*") throw Error("missing assignment journal");
    return { state: parse(value.text), etag: value.etag };
  }
  async function write(etag: string | null, state: AssignmentJournalState) {
    const text = JSON.stringify(state); parse(text);
    if (!await store.compareAndSwap(etag, text)) throw Error("assignment changed; retry");
  }
  function owner(s: AssignmentJournalState, actor: string) { if (actor !== s.owner) throw Error("assignment owner required"); }
  function idle(s: AssignmentJournalState) { if (s.operation && ["cancellations", "replacement"].includes(s.operation.phase)) throw Error("assignment operation pending"); }
  function active(s: AssignmentJournalState, id: string, replacement: string) {
    if (!s.operation || s.operation.id !== id || s.operation.replacement !== replacement || s.operation.phase === "aborted") throw Error("stale or aborted operation");
  }
  return Object.freeze({
    async initialize(initial: Omit<AssignmentJournalState, "version" | "revision" | "operation" | "receipts" | "usedOperations" | "children">) {
      const state: AssignmentJournalState = { ...structuredClone(initial), version: 1, revision: 0, operation: null, receipts: {}, usedOperations: [], children: {} };
      await write(null, state); return state;
    },
    async load() { return (await read()).state; },
    async claim(actor: string, id: string, replacement: string, expectedRevision: number) {
      if (!idOK(id) || !isSeaPubkey(replacement)) throw Error("invalid reassignment intent");
      const { state: s, etag } = await read(); owner(s, actor);
      if (s.operation?.id === id) { active(s, id, replacement); return s; }
      if (s.usedOperations.includes(id)) throw Error("retired operation ID cannot be reused");
      idle(s);
      if (s.rows.length + s.destinations.length * 5 > 1024) throw Error("insufficient assignment journal capacity");
      if (s.revision !== expectedRevision || s.assignee === replacement || s.owner === replacement) throw Error("assignment conflict");
      const next = { ...s, revision: s.revision + 1, usedOperations: [...s.usedOperations, id], operation: { id, previous: s.assignee, replacement, phase: "cancellations" as const } };
      await write(etag, next); return next;
    },
    async bindCancellations(actor: string, id: string, replacement: string, digest: string) {
      const { state: s, etag } = await read(); owner(s, actor); active(s, id, replacement);
      if (!/^[0-9a-f]{64}$/.test(digest)) throw Error("invalid cancellation digest");
      if (s.operation!.cancellationDigest) {
        if (s.operation!.cancellationDigest !== digest) throw Error("cancellation material changed");
        return s;
      }
      if (s.operation!.phase !== "cancellations") throw Error("missing prepared cancellation digest");
      const next = { ...s, revision: s.revision + 1, operation: { ...s.operation!, cancellationDigest: digest } };
      await write(etag, next); return next;
    },
    async abort(actor: string, id: string) {
      const { state: s, etag } = await read(); owner(s, actor);
      if (s.operation?.id !== id) throw Error("stale operation");
      if (s.operation.phase === "aborted") return s;
      if (s.operation.phase !== "cancellations") throw Error("replacement started; retry to finish");
      const next = { ...s, revision: s.revision + 1, operation: { ...s.operation, phase: "aborted" as const } };
      await write(etag, next); return next; // Never restores revoked grants.
    },
    /** Provisioning/ordinary writes must first verify current owner authority.
     * Atomic registration prevents a first-child/assignment freeze race. */
    async admit(actor: string, expectedRevision: number, destination: string, rows: readonly Row[]) {
      const { state: s, etag } = await read(); owner(s, actor); idle(s);
      if (s.revision !== expectedRevision || !isForumObjectId(destination)) throw Error("assignment conflict");
      const known = new Set(s.rows.map(canonical)), additions = structuredClone(rows).filter(r => !known.has(canonical(r)));
      const next = { ...s, revision: s.revision + 1, destinations: [...new Set([...s.destinations, destination])].sort(), rows: [...s.rows, ...additions] };
      await write(etag, next); return next;
    },
    /** Called only after authenticated current child-write and signature checks.
     * CAS on the same journal serializes final dispatch with assignment claim. */
    async writeChild(expectedRevision: number, record: DrawerRecord, signature: string) {
      const { state: s, etag } = await read(); idle(s);
      if (s.revision !== expectedRevision || !s.destinations.includes(record.id)) throw Error("unregistered or stale child write");
      const previous = s.children[record.id]?.record;
      if (previous && (record.rev < previous.rev || (record.rev === previous.rev && JSON.stringify(previous) !== JSON.stringify(record))))
        throw Error("stale child revision");
      if (previous && record.rev === previous.rev) return s;
      const next = { ...s, revision: s.revision + 1, children: { ...s.children, [record.id]: { record, signature } } };
      await write(etag, next); return next;
    },
    mutation(actor: string): AssignmentMutationScope {
      return { async run(id, replacement, work) {
        const initial = await read(); owner(initial.state, actor); active(initial.state, id, replacement);
        let etag = initial.etag, live = true;
        async function current() {
          if (!live) throw Error("expired mutation session");
          const now = await read(); owner(now.state, actor); active(now.state, id, replacement);
          if (now.etag !== etag) throw Error("concurrent assignment mutation; retry");
          return now.state;
        }
        async function change(next: AssignmentJournalState) {
          await write(etag, next);
          const saved = await read();
          if (JSON.stringify(saved.state) !== JSON.stringify(next)) throw Error("concurrent assignment mutation; retry");
          etag = saved.etag;
        }
        try { return await work({
          async assertActive() { await current(); },
          async bindReplacementPlan(digest) {
            const s = await current();
            if (!/^[0-9a-f]{64}$/.test(digest)) throw Error("invalid replacement digest");
            if (s.operation!.grantDigest) {
              if (s.operation!.grantDigest !== digest) throw Error("replacement material changed");
              return;
            }
            if (s.operation!.phase !== "cancellations") throw Error("missing prepared replacement digest");
            await change({ ...s, revision: s.revision + 1, operation: { ...s.operation!, grantDigest: digest } });
          },
          async beginReplacement() {
            const s = await current(); if (!s.operation!.grantDigest) throw Error("replacement plan not bound");
            if (s.operation!.phase === "replacement") return;
            if (s.operation!.phase !== "cancellations") throw Error("operation already complete");
            await change({ ...s, revision: s.revision + 1, operation: { ...s.operation!, phase: "replacement" } });
          },
          async publish(phase, record) {
            const s = await current();
            if (!s.operation!.cancellationDigest || (phase === "replacement" && !s.operation!.grantDigest)) throw Error("unprepared publication");
            if (s.operation!.phase !== phase) throw Error("publication phase changed");
            const row = { kind: record.kind, soul: record.soul, record: JSON.parse(record.recordJson) };
            const identity = canonical(row);
            if (s.rows.some(r => canonical(r) === identity)) return;
            await change({ ...s, revision: s.revision + 1, rows: [...s.rows, row] });
          },
          async commit(proof) {
            const s = await current();
            if (proof.operationId !== id || proof.replacement !== replacement || proof.evaluatedAt !== clock()) throw Error("stale assignment evidence");
            const old = s.receipts[id]; if (old) return old;
            if (!s.operation!.cancellationDigest || !s.operation!.grantDigest) throw Error("unprepared assignment commit");
            // An already-effective exact plan may skip publication after restart.
            const receipt = { operationId: id, replacement, evaluatedAt: proof.evaluatedAt, revision: String(s.revision + 1) };
            await change({ ...s, assignee: replacement, revision: s.revision + 1,
              operation: { ...s.operation!, phase: "complete" }, receipts: { ...s.receipts, [id]: receipt } });
            return receipt;
          },
        }); } finally { live = false; }
      } };
    },
  });
}
