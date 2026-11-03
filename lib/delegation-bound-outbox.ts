import { createCancellationOutbox, snapshotCancellationOperation, type CancellationEnvelope, type CancellationOperation } from "./delegation-outbox";
import { createDelegationInventory } from "./delegation-inventory";
import { recoveryBytes, recoveryId, recoveryObject } from "./identity/forum-recovery-records";
import { isForumObjectId, isSeaPubkey } from "./identity/forum-check";

/** Bind recovery material to a trusted coordinator scope and exact frozen
 * destination registry. The digest is correlation/integrity, not a signing
 * domain, ACL proof, inventory-completeness proof, or assignment completion receipt.
 * Both dependencies must use the same authenticated storage namespace.
 */
export function createInventoryBoundOutbox(
  inventory: Pick<ReturnType<typeof createDelegationInventory>, "load">,
  outbox: ReturnType<typeof createCancellationOutbox>,
  scope: Readonly<{ forum: string; agent: string }>,
) {
  const input = recoveryObject(scope);
  if (!input || typeof input.forum !== "string" || !isForumObjectId(input.forum, "forum") ||
      typeof input.agent !== "string" || !isSeaPubkey(input.agent)) throw Error("invalid coordinator scope");
  const forum = input.forum, agent = input.agent;
  async function binding(operationId: string) {
    if (typeof operationId !== "string" || !/^[0-9a-f]{32}$/.test(operationId)) throw Error("invalid operation ID");
    const state = await inventory.load();
    if (state.operation !== operationId) throw Error("operation does not own frozen inventory");
    return recoveryId(recoveryBytes(["s3rch-cancellation-inventory-binding-v1", forum, agent,
      operationId, String(state.destinations.length), ...state.destinations]));
  }
  function check(saved: CancellationOperation, operationId: string, fence: string) {
    if (saved.operationId !== operationId || saved.forum !== forum || saved.agent !== agent || saved.fence !== fence)
      throw Error("cancellation inventory binding mismatch");
  }
  async function prepare(operationId: string, cancellations: readonly CancellationEnvelope[], replacement?: string) {
    // Snapshot signed material before inventory I/O can yield to the caller.
    const request = snapshotCancellationOperation({ operationId, forum, agent, fence: "unbound", cancellations,
      ...(replacement === undefined ? {} : { replacement }) });
    const fence = await binding(operationId);
    const saved = await outbox.prepare({ ...request, fence });
    // Frozen state is immutable by contract. Still fail closed on unexpected
    // storage loss/replacement during preparation; retain saved bytes for diagnosis.
    check(saved, operationId, await binding(operationId));
    return saved;
  }
  async function load(operationId: string) {
    const fence = await binding(operationId), saved = await outbox.load(operationId);
    if (await binding(operationId) !== fence) throw Error("inventory changed during recovery");
    if (saved) check(saved, operationId, fence);
    return saved;
  }
  return Object.freeze({
    prepare(operationId: string, cancellations: readonly CancellationEnvelope[]) {
      return prepare(operationId, cancellations);
    },
    load,
    async prepareReassignment(operationId: string, replacement: string, cancellations: readonly CancellationEnvelope[]) {
      if (typeof replacement !== "string" || !isSeaPubkey(replacement) || replacement === agent) throw Error("invalid replacement assignee");
      return prepare(operationId, cancellations, replacement);
    },
    async loadReassignment(operationId: string, expectedReplacement: string) {
      if (typeof expectedReplacement !== "string" || !isSeaPubkey(expectedReplacement) || expectedReplacement === agent) throw Error("invalid replacement assignee");
      const saved = await load(operationId);
      // Legacy cancellation-only records stay readable but can never silently
      // become a reassignment to a target supplied after cancellation.
      if (!saved || saved.replacement !== expectedReplacement) throw Error("missing or mismatched reassignment intent");
      return saved;
    },
  });
}
