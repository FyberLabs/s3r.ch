import { assignmentCancellationIntents, assignmentReplacementIntents } from "./assignment-signing-plan";
import { isSeaPubkey } from "./identity/forum-check";
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
import type { AuthorityKind } from "./identity/forum-authority-records";
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
  async function prepareCancellations(actor: string, id: string, replacement: string) {
    const b = await bindings(id, replacement);
    const existing = await b.outbox.load(id);
    if (existing) {
      await input.journal.bindCancellations(actor, id, replacement, await recoveryId(recoveryBytes(["assignment-cancellation-plan-v1", JSON.stringify(existing)])));
      return b;
    }
    if (b.op.cancellationDigest) throw Error("missing prepared cancellations");
    let intents: Awaited<ReturnType<typeof assignmentCancellationIntents>> | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const at = clock(), authority = createForumAuthority(input.config, clock);
      const admitted = await authority.refresh({ completeThrough: at, rows: b.state.rows, history: await input.history(at) }, at);
      if (clock() !== at) continue;
      if (!admitted.ok || admitted.diagnostics.length) throw Error("unverified group cancellation authority");
      const planned = await assignmentCancellationIntents(b.state, id, b.op.previous, at, authority.graph);
      if (clock() !== at) continue;
      intents = planned; break;
    }
    if (!intents) throw Error("group authority expired; retry");
    const rows: Row[] = [];
    for (const intent of intents) rows.push(await input.sign(intent.kind, { ...intent.fields }));
    const prepared = await b.outbox.prepareReassignment(id, replacement, envelopes(rows));
    await input.journal.bindCancellations(actor, id, replacement, await recoveryId(recoveryBytes(["assignment-cancellation-plan-v1", JSON.stringify(prepared)])));
    return b;
  }
  return Object.freeze({
    async read(actor: string) { return owner(actor); },
    /** Prepare a new operation without claiming it, creating outboxes or signing.
     * The caller authenticates actor; this plan is not authority or a commit. */
    async plan(actor: string, id: string, replacement: string, expectedRevision: number) {
      const state = await owner(actor), at = clock();
      if (!/^[0-9a-f]{32}$/.test(id) || !isSeaPubkey(replacement) || replacement === state.owner || replacement === state.assignee ||
          state.usedOperations.includes(id) || state.revision !== expectedRevision ||
          state.operation && ["cancellations", "replacement"].includes(state.operation.phase)) throw Error("assignment plan conflict");
      const authority = createForumAuthority(input.config, clock);
      const admitted = await authority.refresh({ completeThrough: at, rows: state.rows, history: await input.history(at) }, at);
      if (!admitted.ok || admitted.diagnostics.length || authority.graph.ownerOf(state.forum) !== actor || clock() !== at) throw Error("assignment plan authority expired");
      const cancellations = await assignmentCancellationIntents(state, id, state.assignee, at, authority.graph);
      const grants = assignmentReplacementIntents(state, replacement, at);
      if (clock() !== at || (await input.journal.load()).revision !== state.revision || clock() !== at) throw Error("assignment plan changed");
      return Object.freeze({ version: 1 as const, forum: state.forum, owner: state.owner, previous: state.assignee,
        operationId: id, replacement, revision: state.revision, issuedAt: at, cancellations, grants });
    },
    async start(actor: string, id: string, replacement: string, expectedRevision: number) {
      const state = await owner(actor), receipt = state.receipts[id];
      if (receipt) {
        if (receipt.replacement !== replacement) throw Error("receipt replacement mismatch");
        return { status: "complete" as const, receipt };
      }
      await input.journal.claim(actor, id, replacement, expectedRevision);
      return this.resume(actor, id, replacement);
    },
    async resume(actor: string, id: string, replacement: string) {
      const state = await owner(actor), receipt = state.receipts[id];
      if (receipt) {
        if (receipt.replacement !== replacement) throw Error("receipt replacement mismatch");
        return { status: "complete" as const, receipt };
      }
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
          for (const intent of assignmentReplacementIntents(state, replacement, clock()))
            grants.push(await input.sign(intent.kind, { ...intent.fields }));
          await b.plans.prepare(id, replacement, envelopes(grants));
        } });
      return publisher.resume(id, replacement);
    },
    async abort(actor: string, id: string) { await owner(actor); return input.journal.abort(actor, id); },
    async readChild(actor: string, id: string) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const state = await input.journal.load(), at = clock(), authority = createForumAuthority(input.config, clock);
        const admitted = await authority.refresh(await source(at), at);
        if (clock() !== at) continue;
        const saved = state.children[id] ?? null;
        if (!admitted.ok || admitted.diagnostics.length || !state.destinations.includes(id) ||
            !authority.graph.checkDirectSee(id, actor, at).allowed ||
            (saved?.record.target && !authority.graph.checkDirectSee(saved.record.target, actor, at).allowed)) throw Error("child read denied");
        return saved;
      }
      throw Error("child read authority expired; retry");
    },
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
