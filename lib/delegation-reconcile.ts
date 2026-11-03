import type { createInventoryBoundOutbox } from "./delegation-bound-outbox";
import type { createDelegationInventory } from "./delegation-inventory";
import { createForumAuthority, type ForumAuthorityConfig, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { recoveryList, recoveryObject } from "./identity/forum-recovery-records";

type Result = Readonly<{ ok: true; operationId: string; evaluatedAt: number; fence: string; status: "acl-reconciled" }> |
  Readonly<{ ok: false; reason: string }>;
/** The provider must supply complete authenticated history and durable ACL
 * evidence, not a browser cache or a Gun put acknowledgement. All three ports
 * must refer to the same trusted coordinator scope. Success is an instantaneous
 * ACL check, not a durable assignment-completion receipt.
 */
export function createCancellationReconciler(input: {
  inventory: Pick<ReturnType<typeof createDelegationInventory>, "load">;
  outbox: Pick<ReturnType<typeof createInventoryBoundOutbox>, "load">;
  source: (at: number) => Promise<ForumAuthoritySnapshot>;
  config: ForumAuthorityConfig;
  clock?: () => number;
}) {
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  return Object.freeze({ async reconcile(operationId: string): Promise<Result> {
    const fail = (reason: string): Result => Object.freeze({ ok: false, reason });
    try {
      const saved = await input.outbox.load(operationId);
      if (!saved) return fail("missing-cancellation-operation");
      const inventory = await input.inventory.load();
      if (inventory.operation !== operationId) return fail("inventory-not-frozen-for-operation");
      const at = clock(), supplied = recoveryObject(await input.source(at));
      const rawRows = supplied && recoveryList(supplied.rows);
      if (!supplied || !rawRows) return fail("invalid-authority-source");
      // Normalize the same rows that refresh will verify before any await.
      // Never compare stored records to mutable provider data after verification.
      const rows: ForumAuthoritySnapshot["rows"][number][] = [];
      const evidence = new Set<string>();
      for (const raw of rawRows) {
        const r = recoveryObject(raw), p = r && parseForumAuthority(r.kind as AuthorityKind, r.record);
        if (!p || r!.soul !== p.soul) return fail("invalid-authority-record");
        rows.push({ kind: p.kind, soul: p.soul, record: p.row });
        evidence.add(JSON.stringify([p.kind, p.soul, p.row]));
      }
      const authority = createForumAuthority(input.config, clock);
      const admitted = await authority.refresh({ completeThrough: supplied.completeThrough as number,
        history: supplied.history as ForumAuthoritySnapshot["history"], rows }, at);
      if (!admitted.ok || admitted.diagnostics.length) return fail("unverified-authority");
      for (const record of saved.cancellations) {
        const p = parseForumAuthority(record.kind, JSON.parse(record.recordJson));
        if (!p?.cancellation || !evidence.has(JSON.stringify([p.kind, p.soul, p.row]))) return fail("missing-exact-cancellation");
      }
      for (const destination of inventory.destinations) {
        const graph = authority.graph;
        if (!graph.ownerOf(destination)) return fail("missing-destination-authority");
        if (graph.checkPost(destination, saved.agent, at).allowed ||
            graph.checkDirectSee(destination, saved.agent, at).allowed ||
            graph.checkForumSee(destination, saved.agent, at).allowed) return fail("access-remains");
      }
      // Recheck storage binding after asynchronous proof work. Neither a changed
      // outbox nor a replacement registry may inherit this result.
      const current = await input.outbox.load(operationId), latest = await input.inventory.load();
      if (!current || JSON.stringify(current) !== JSON.stringify(saved) ||
          JSON.stringify(latest) !== JSON.stringify(inventory)) return fail("operation-changed");
      if (clock() !== at) return fail("stale-evaluation");
      return Object.freeze({ ok: true, operationId, evaluatedAt: at, fence: saved.fence, status: "acl-reconciled" });
    } catch { return fail("evidence-unavailable"); }
  } });
}
