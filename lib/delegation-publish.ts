import { recoveryBytes, recoveryId } from "./identity/forum-recovery-records";
import type { CancellationEnvelope } from "./delegation-outbox";
import type { createCancellationReconciler } from "./delegation-reconcile";
import type { createInventoryBoundOutbox } from "./delegation-bound-outbox";
import type { createReplacementGrantOutbox } from "./delegation-replacement-grants";

export type AssignmentReceipt = Readonly<{ operationId: string; replacement: string; revision: string; evaluatedAt: number }>;
export type AssignmentRunResult = Readonly<{ status: "complete"; receipt: AssignmentReceipt }> |
  Readonly<{ status: "pending"; operationId: string; stage: "cancellations" | "replacement" | "commit"; reason: string }>;
/** Implement at the authoritative mutation sink, not with a browser mutex or a
 * lease checked before an unconditional Gun put. Every writer that can change
 * the assignment, destination inventory or grants must participate. A session's
 * writes must be rejected by the sink if its operation/generation is superseded.
 * The callback cannot outlive its session. No runtime/worker lifecycle is involved.
 */
export type AssignmentMutationScope = {
  run<T>(operationId: string, replacement: string, work: (session: AssignmentMutationSession) => Promise<T>): Promise<T>;
};
export type AssignmentMutationSession = {
  /** Uses authenticated owner identity and the current operation, never client
   * supplied ownership/status metadata. Must reject canceled/stale operations. */
  assertActive(): Promise<void>;
  /** Atomically enters the irreversible replacement phase at the sink before
   * any new grant. Abort thereafter must refuse rather than leave hidden grants. */
  bindReplacementPlan(digest: string): Promise<void>;
  beginReplacement(): Promise<void>;
  /** Idempotent exact-byte publication. Acknowledgement is not ACL evidence. */
  publish(phase: "cancellations" | "replacement", record: CancellationEnvelope): Promise<void>;
  /** Atomic conditional assignment commit, only after fresh reconciliation.
   * Preserve object owners/paths and prior operation history. Same operation
   * retries must return the original durable receipt, never another revision. */
  commit(input: { operationId: string; replacement: string; fence: string; evaluatedAt: number }): Promise<AssignmentReceipt>;
};

/** Resume only persisted operations. This orchestrates existing signed retry
 * bytes; it never signs, restores old grants, changes paths, or infers completion
 * from a put acknowledgement. Ports share one authenticated assignment scope.
 * prepareReplacement must durably save fresh owner-authorized grants in plans;
 * it is called only if no plan exists, after old access is durably reconciled.
 */
export function createAssignmentPublisher(input: {
  mutation: AssignmentMutationScope;
  outbox: Pick<ReturnType<typeof createInventoryBoundOutbox>, "loadReassignment">;
  plans: Pick<ReturnType<typeof createReplacementGrantOutbox>, "load">;
  reconcile: ReturnType<typeof createCancellationReconciler>;
  prepareReplacement(operationId: string, replacement: string): Promise<void>;
  clock?: () => number;
}) {
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  return Object.freeze({ async resume(operationId: string, replacement: string): Promise<AssignmentRunResult> {
    let stage: "cancellations" | "replacement" | "commit" = "cancellations";
    const pending = (reason: string): AssignmentRunResult => Object.freeze({ status: "pending", operationId, stage, reason });
    try {
      return await input.mutation.run(operationId, replacement, async session => {
        await session.assertActive();
        const intent = await input.outbox.loadReassignment(operationId, replacement);
        let canceled = await input.reconcile.reconcile(operationId);
        if (!canceled.ok) {
          const preflight = await input.reconcile.preflightCancellation(operationId);
          if (!preflight.ok) return pending(preflight.reason);
          if (preflight.status !== "cancellation-publication-ready") return pending("invalid-cancellation-preflight");
          for (const record of preflight.cancellations) {
            await session.assertActive();
            const current = await input.reconcile.preflightCancellation(operationId);
            if (!current.ok) return pending(current.reason);
            if (current.status !== "cancellation-publication-ready" || clock() !== current.evaluatedAt ||
                JSON.stringify(current.cancellations) !== JSON.stringify(preflight.cancellations)) return pending("stale-cancellation-preflight");
            await session.publish("cancellations", record);
          }
          canceled = await input.reconcile.reconcile(operationId);
          if (!canceled.ok) return pending(canceled.reason);
        }
        stage = "replacement";
        await session.assertActive();
        if (!(await input.plans.load(operationId, replacement))) await input.prepareReplacement(operationId, replacement);
        const plan = await input.plans.load(operationId, replacement);
        if (!plan) return pending("missing-replacement-plan");
        await session.bindReplacementPlan(await recoveryId(recoveryBytes(["assignment-replacement-plan-v1", JSON.stringify(plan)])));
        let access = await input.reconcile.reconcileReassignment(operationId, replacement);
        if (!access.ok) {
          const preflight = await input.reconcile.preflightReplacement(operationId, replacement);
          if (!preflight.ok) return pending(preflight.reason);
          if (preflight.status !== "replacement-publication-ready" || JSON.stringify(preflight.grants) !== JSON.stringify(plan.grants))
            return pending("replacement-plan-changed");
          await session.beginReplacement();
          for (const record of plan.grants) {
            await session.assertActive();
            const current = await input.reconcile.preflightReplacement(operationId, replacement);
            if (!current.ok) return pending(current.reason);
            if (current.status !== "replacement-publication-ready" || clock() !== current.evaluatedAt ||
                JSON.stringify(current.grants) !== JSON.stringify(plan.grants)) return pending("stale-replacement-preflight");
            await session.publish("replacement", record);
          }
        }
        stage = "commit";
        await session.assertActive();
        access = await input.reconcile.reconcileReassignment(operationId, replacement);
        if (!access.ok) return pending(access.reason);
        if (access.status !== "reassignment-access-reconciled" || access.replacement !== replacement ||
            access.fence !== intent.fence || clock() !== access.evaluatedAt) return pending("stale-assignment-evidence");
        const receipt = await session.commit({ operationId, replacement, fence: access.fence, evaluatedAt: access.evaluatedAt });
        if (receipt.operationId !== operationId || receipt.replacement !== replacement ||
            typeof receipt.revision !== "string" || !receipt.revision || !Number.isSafeInteger(receipt.evaluatedAt))
          return pending("invalid-assignment-receipt");
        return Object.freeze({ status: "complete", receipt: Object.freeze({ ...receipt }) });
      });
    } catch { return pending("retry-required"); }
  } });
}
