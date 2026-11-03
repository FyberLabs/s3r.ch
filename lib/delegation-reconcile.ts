import type { CancellationEnvelope } from "./delegation-outbox";
import type { createInventoryBoundOutbox } from "./delegation-bound-outbox";
import type { createReplacementGrantOutbox } from "./delegation-replacement-grants";
import { isSeaPubkey } from "./identity/forum-check";
import type { createDelegationInventory } from "./delegation-inventory";
import { createForumAuthority, type ForumAuthorityConfig, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { recoveryList, recoveryObject } from "./identity/forum-recovery-records";

type Result = Readonly<{ ok: true; operationId: string; evaluatedAt: number; fence: string; status: "acl-reconciled" }> |
  Readonly<{ ok: true; operationId: string; evaluatedAt: number; fence: string; status: "reassignment-access-reconciled"; replacement: string; checkedGrants: number }> |
  Readonly<{ ok: true; operationId: string; evaluatedAt: number; fence: string; status: "replacement-publication-ready"; replacement: string; grants: readonly CancellationEnvelope[] }> |
  Readonly<{ ok: false; reason: string }>;
/** The provider must supply complete authenticated history and durable ACL
 * evidence, not a browser cache or a Gun put acknowledgement. All ports
 * must refer to the same trusted coordinator scope. Success is an instantaneous
 * ACL check, not a durable assignment-completion receipt.
 */
export function createCancellationReconciler(input: {
  inventory: Pick<ReturnType<typeof createDelegationInventory>, "load">;
  outbox: Pick<ReturnType<typeof createInventoryBoundOutbox>, "load">;
  replacementGrants?: Pick<ReturnType<typeof createReplacementGrantOutbox>, "load">;
  source: (at: number) => Promise<ForumAuthoritySnapshot>;
  config: ForumAuthorityConfig;
  clock?: () => number;
}) {
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  async function reconcile(operationId: string, replacement: string | null = null, preflight = false): Promise<Result> {
    const fail = (reason: string): Result => Object.freeze({ ok: false, reason });
    try {
      const saved = await input.outbox.load(operationId);
      if (!saved) return fail("missing-cancellation-operation");
      const inventory = await input.inventory.load();
      if (inventory.operation !== operationId) return fail("inventory-not-frozen-for-operation");
      if (replacement !== null && saved.replacement !== replacement) return fail("replacement-intent-mismatch");
      const plan = replacement === null ? null : await input.replacementGrants?.load(operationId, replacement);
      if (replacement !== null && !plan) return fail("missing-replacement-plan");
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
      // Prospective rows are restricted to positive direct grants for the saved
      // replacement, so they cannot cancel old access or introduce ownership.
      // Keep durable evidence separate: candidates never establish publication.
      if (preflight && plan) for (const record of plan.grants) {
        const p = parseForumAuthority(record.kind, JSON.parse(record.recordJson));
        if (!p || (p.kind !== "see" && p.kind !== "post") || p.cancellation ||
            p.row.accessor !== replacement || !inventory.destinations.includes(p.row.object))
          return fail("invalid-replacement-candidate");
        rows.push({ kind: p.kind, soul: p.soul, record: p.row });
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
      for (const record of plan?.grants ?? []) {
        const p = parseForumAuthority(record.kind, JSON.parse(record.recordJson));
        if (!p || (p.kind !== "see" && p.kind !== "post") || p.cancellation ||
            p.row.accessor !== replacement || !inventory.destinations.includes(p.row.object) ||
            (!preflight && !evidence.has(JSON.stringify([p.kind, p.soul, p.row])))) return fail("missing-exact-replacement-grant");
        // Independent group access cannot stand in for a saved direct-see grant.
        // Presence of a signed record alone does not prove it is effective now.
        const check = p.kind === "post" ? authority.graph.checkPost : authority.graph.checkDirectSee;
        if (at < p.row.from || at >= p.row.until || !check(p.row.object, p.row.accessor, at).allowed)
          return fail("replacement-access-missing");
      }
      // Recheck storage binding after asynchronous proof work. Neither a changed
      // outbox nor a replacement registry may inherit this result.
      const current = await input.outbox.load(operationId), latest = await input.inventory.load();
      if (!current || JSON.stringify(current) !== JSON.stringify(saved) ||
          JSON.stringify(latest) !== JSON.stringify(inventory)) return fail("operation-changed");
      if (replacement !== null) {
        const latestPlan = await input.replacementGrants?.load(operationId, replacement);
        if (!latestPlan || JSON.stringify(latestPlan) !== JSON.stringify(plan)) return fail("replacement-plan-changed");
      }
      if (clock() !== at) return fail("stale-evaluation");
      if (preflight && replacement !== null && plan) return Object.freeze({ ok: true, operationId, evaluatedAt: at,
        fence: saved.fence, status: "replacement-publication-ready", replacement, grants: plan.grants });
      if (replacement !== null && plan) return Object.freeze({ ok: true, operationId, evaluatedAt: at,
        fence: saved.fence, status: "reassignment-access-reconciled", replacement, checkedGrants: plan.grants.length });
      return Object.freeze({ ok: true, operationId, evaluatedAt: at, fence: saved.fence, status: "acl-reconciled" });
    } catch { return fail("evidence-unavailable"); }
  }
  return Object.freeze({
    reconcile: (operationId: string) => reconcile(operationId),
    // Internal preflight only: the publisher must serialize assignment/grant
    // mutations and revalidate at dispatch. This is not a durable permission token.
    async preflightReplacement(operationId: string, replacement: string): Promise<Result> {
      if (typeof replacement !== "string" || !isSeaPubkey(replacement))
        return Object.freeze({ ok: false, reason: "invalid-replacement" });
      return reconcile(operationId, replacement, true);
    },
    async reconcileReassignment(operationId: string, replacement: string): Promise<Result> {
      if (typeof replacement !== "string" || !isSeaPubkey(replacement))
        return Object.freeze({ ok: false, reason: "invalid-replacement" });
      return reconcile(operationId, replacement);
    },
  });
}
