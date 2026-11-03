import { parseDrawerRecord } from "./forum-drawer";
import { readForumSignature } from "./forum-sign";
import { checkForumChildWrite } from "./identity/forum-child-write";
import { createAssignmentJournal } from "./delegation-journal";
import { createAssignmentPublisher } from "./delegation-publish";
import { createDelegationInventory, type InventoryStore } from "./delegation-inventory";
import { createCancellationOutbox, type CancellationOutboxStore } from "./delegation-outbox";
import { createInventoryBoundOutbox } from "./delegation-bound-outbox";
import { createReplacementGrantOutbox } from "./delegation-replacement-grants";
import { createCancellationReconciler } from "./delegation-reconcile";
import { createForumAuthority, type ForumAuthorityConfig, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { recoveryBytes, recoveryId } from "./identity/forum-recovery-records";

type Row = ForumAuthoritySnapshot["rows"][number];
/** Server-side runtime. actor is the authenticated session principal; never a
 * browser body field. Source history/config and all stores are provisioned by
 * the operator. The signer must hold the current destination-owner key; a
 * synthetic signer belongs only in the isolated acceptance server.
 */
export function createDelegationRuntime(input: {
  journal: ReturnType<typeof createAssignmentJournal>;
  operationStores(id: string): { inventory: InventoryStore; cancellations: CancellationOutboxStore; grants: CancellationOutboxStore };
  history(at: number): Promise<ForumAuthoritySnapshot["history"]>;
  config: ForumAuthorityConfig;
  sign(kind: AuthorityKind, fields: Record<string, unknown>): Promise<Row>;
  clock?: () => number;
}) {
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  async function source(at: number): Promise<ForumAuthoritySnapshot> {
    const state = await input.journal.load();
    return { completeThrough: at, history: await input.history(at), rows: state.rows };
  }
  async function owner(actor: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await input.journal.load(), at = clock();
      if (actor !== state.owner) throw Error("assignment owner required");
      const authority = createForumAuthority(input.config, clock);
      const result = await authority.refresh(await source(at), at);
      if (clock() !== at) continue;
      if (!result.ok || result.diagnostics.length || authority.graph.ownerOf(state.forum) !== actor)
        throw Error("unverified assignment owner");
      return state;
    }
    throw Error("assignment evidence expired; retry");
  }
  async function bindings(id: string, replacement: string) {
    const state = await input.journal.load(), op = state.operation;
    if (!op || op.id !== id || op.replacement !== replacement || op.phase === "aborted") throw Error("stale operation");
    const stores = input.operationStores(id), inventory = createDelegationInventory(stores.inventory);
    // Explicit provisioning after durable operation claim; retries accept only
    // an exact preexisting registry. A frozen registry is checked directly.
    const present = await stores.inventory.read();
    if (!present) {
      if (op.cancellationDigest) throw Error("missing prepared inventory");
      await inventory.initialize(state.destinations);
    }
    const held = await inventory.load();
    if (JSON.stringify(held.destinations) !== JSON.stringify([...state.destinations].sort())) throw Error("inventory changed");
    await inventory.freeze(id);
    const outbox = createInventoryBoundOutbox(inventory, createCancellationOutbox(stores.cancellations), { forum: state.forum, agent: op.previous });
    const plans = createReplacementGrantOutbox({ inventory, outbox, store: stores.grants });
    return { state, op, inventory, outbox, plans };
  }
  const envelopes = (rows: readonly Row[]) => rows.map(r => ({ kind: r.kind, soul: r.soul, recordJson: JSON.stringify(r.record) }));
  async function direct(kind: "post" | "see", object: string, accessor: string, stated: 0 | 1, rows: readonly Row[]) {
    const at = clock(), state = await input.journal.load();
    const matching = rows.flatMap(r => { const p = parseForumAuthority(r.kind, r.record);
      return p && p.kind === kind && p.row.object === object && p.row.accessor === accessor ? [p.row.hamState] : []; });
    const hamState = Math.max(0, ...matching) + 1;
    if (!Number.isSafeInteger(hamState)) throw Error("grant revision exhausted");
    return input.sign(kind, { owner: state.owner, object, accessor, stated, hamState, issuedAt: at, from: at, until: at + 86400 });
  }
  async function prepareCancellations(actor: string, id: string, replacement: string) {
    const b = await bindings(id, replacement);
    const existing = await b.outbox.load(id);
    if (existing) {
      await input.journal.bindCancellations(actor, id, replacement, await recoveryId(recoveryBytes(["assignment-cancellation-plan-v1", JSON.stringify(existing)])));
      return b;
    }
    if (b.op.cancellationDigest) throw Error("missing prepared cancellations");
    const rows: Row[] = [];
    for (const destination of b.state.destinations) for (const kind of ["post", "see"] as const)
      rows.push(await direct(kind, destination, b.op.previous, 0, b.state.rows));
    // Cancel membership of the old assignee, preserving object owners/paths and
    // other group members. Every relevant membership must be owner-signable.
    const groups = new Map<string, { set: string; predicate: string; soul: string; setOwner: string }>();
    for (const r of b.state.rows) {
      const p = parseForumAuthority(r.kind, r.record);
      if (!p || p.kind !== "object-set" || !b.state.destinations.includes(p.row.object)) continue;
      for (const member of b.state.rows) {
        const m = parseForumAuthority(member.kind, member.record);
        if (m?.kind === "membership" && m.row.member === b.op.previous && m.row.set === p.row.set && m.row.predicate === p.row.predicate)
          groups.set(m.soul, { set: m.row.set, predicate: m.row.predicate, soul: m.soul, setOwner: m.row.setOwner });
      }
    }
    for (const group of groups.values()) {
      if (group.setOwner !== b.state.owner) throw Error("external group owner cancellation required");
      const prior = b.state.rows.flatMap(r => { const p = parseForumAuthority(r.kind, r.record);
        return p?.kind === "cancel" && p.soul === group.soul ? [p.row.cancelId] : []; }).sort();
      const cancelId = await recoveryId(new TextEncoder().encode(JSON.stringify(["assignment-membership-cancel-v1", id, group.soul])));
      rows.push(await input.sign("cancel", { kind: "membership", rowSoul: group.soul, cancelId, prior: [...new Set(prior)],
        signer: b.state.owner, predicate: group.predicate, set: group.set, member: b.op.previous, setOwner: group.setOwner, issuedAt: clock() }));
    }
    const prepared = await b.outbox.prepareReassignment(id, replacement, envelopes(rows));
    await input.journal.bindCancellations(actor, id, replacement, await recoveryId(recoveryBytes(["assignment-cancellation-plan-v1", JSON.stringify(prepared)])));
    return b;
  }
  return Object.freeze({
    async read(actor: string) { return owner(actor); },
    async start(actor: string, id: string, replacement: string, expectedRevision: number) {
      await owner(actor); await input.journal.claim(actor, id, replacement, expectedRevision);
      return this.resume(actor, id, replacement);
    },
    async resume(actor: string, id: string, replacement: string) {
      await owner(actor);
      // A missing cancellation document after the first journal publication must
      // never mint replacement cancellation bytes. Provisioning is allowed only
      // while no record for this operation has been published (enforced below).
      const b = await prepareCancellations(actor, id, replacement);
      const reconciler = createCancellationReconciler({ inventory: b.inventory, outbox: b.outbox,
        replacementGrants: b.plans, source, config: input.config, clock });
      const publisher = createAssignmentPublisher({ mutation: input.journal.mutation(actor), outbox: b.outbox, plans: b.plans, reconcile: reconciler, clock,
        async prepareReplacement() {
          const state = await input.journal.load(), grants: Row[] = [];
          if (state.operation?.grantDigest) throw Error("missing prepared replacement plan");
          for (const destination of state.destinations) for (const kind of ["post", "see"] as const)
            grants.push(await direct(kind, destination, replacement, 1, state.rows));
          await b.plans.prepare(id, replacement, envelopes(grants));
        } });
      return publisher.resume(id, replacement);
    },
    async abort(actor: string, id: string) { await owner(actor); return input.journal.abort(actor, id); },
    async publishChild(actor: string, expectedRevision: number, raw: unknown, signature: string) {
      const record = parseDrawerRecord(raw), state = await input.journal.load();
      if (!record || record.writer !== actor || record.forumId !== state.forum || record.agent !== state.owner)
        throw Error("invalid child scope");
      for (let attempt = 0; attempt < 3; attempt++) {
        const at = clock();
        if (record.issuedAt > at) throw Error("future child record");
        const authority = createForumAuthority(input.config, clock), admitted = await authority.refresh(await source(at), at);
        const key = authority.graph.writerKey(actor, record.issuedAt, at);
        if (clock() !== at) continue;
        if (!admitted.ok || admitted.diagnostics.length || !key ||
            !checkForumChildWrite(authority.graph, state.forum, state.owner, record.id, actor, at).allowed ||
            (record.kind === "artifact" && !authority.graph.checkDirectSee(record.target, actor, at).allowed)) throw Error("child access denied");
        const verified = parseDrawerRecord(await readForumSignature(signature, key));
        if (clock() !== at) continue;
        if (!verified || JSON.stringify(verified) !== JSON.stringify(record)) throw Error("invalid child signature");
        return input.journal.writeChild(expectedRevision, record, signature);
      }
      throw Error("child authority expired; retry");
    },
    async admit(actor: string, expectedRevision: number, destination: string, rows: readonly Row[]) {
      const state = await owner(actor);
      for (let attempt = 0; attempt < 3; attempt++) {
        const at = clock(), authority = createForumAuthority(input.config, clock);
        const snapshot = await source(at), admitted = await authority.refresh({ ...snapshot, rows: [...snapshot.rows, ...rows] }, at);
        if (clock() !== at) continue;
        if (!admitted.ok || admitted.diagnostics.length || authority.graph.ownerOf(destination) !== state.owner)
          throw Error("unverified destination admission");
        return input.journal.admit(actor, expectedRevision, destination, rows);
      }
      throw Error("destination authority expired; retry");
    },
  });
}
