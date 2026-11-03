import type { createInventoryBoundOutbox } from "./delegation-bound-outbox";
import type { createDelegationInventory } from "./delegation-inventory";
import type { CancellationEnvelope, CancellationOutboxStore } from "./delegation-outbox";
import { parseForumAuthority } from "./identity/forum-authority-records";
import { recoveryBytes, recoveryId, recoveryList, recoveryObject } from "./identity/forum-recovery-records";

export type ReplacementGrantPlan = Readonly<{
  version: 1; operationId: string; operationDigest: string;
  grants: readonly CancellationEnvelope[];
}>;
const cap = 1_048_576;
const bytes = (text: string) => new TextEncoder().encode(text).length;
function snapshotGrants(input: unknown): readonly CancellationEnvelope[] {
  const list = recoveryList(input), souls = new Set<string>();
  if (!list?.length || list.length > 512) throw Error("invalid replacement grant batch");
  return Object.freeze(list.map(raw => {
    const r = recoveryObject(raw);
    if (!r || Object.keys(r).sort().join() !== "kind,recordJson,soul" ||
        (r.kind !== "see" && r.kind !== "post") || typeof r.soul !== "string" ||
        typeof r.recordJson !== "string" || bytes(r.recordJson) > 32768) throw Error("invalid replacement grant");
    const p = parseForumAuthority(r.kind, JSON.parse(r.recordJson));
    if (!p || p.cancellation || p.soul !== r.soul || souls.has(r.soul)) throw Error("invalid or duplicate replacement grant");
    souls.add(r.soul);
    return Object.freeze({ kind: r.kind, soul: r.soul, recordJson: r.recordJson });
  }));
}
/** Exact retry material, not permission to publish or proof of completed access.
 * The caller must authorize fresh grants independently, persist before publishing,
 * and reconcile durable ACL evidence after publication. All ports must share the
 * same trusted scope. The store uses a separate slot from cancellation records.
 */
export function createReplacementGrantOutbox(input: {
  inventory: Pick<ReturnType<typeof createDelegationInventory>, "load">;
  outbox: Pick<ReturnType<typeof createInventoryBoundOutbox>, "loadReassignment">;
  store: CancellationOutboxStore;
}) {
  async function binding(operationId: string, replacement: string) {
    const saved = await input.outbox.loadReassignment(operationId, replacement);
    const inventory = await input.inventory.load();
    if (inventory.operation !== operationId) throw Error("inventory not owned by reassignment");
    // Bind all exact cancellation bytes and target intent, not just the inventory
    // digest. Changes to either document must invalidate the grant plan.
    const digest = await recoveryId(recoveryBytes(["s3rch-replacement-grants-v1", JSON.stringify(saved), JSON.stringify(inventory)]));
    return { digest, destinations: inventory.destinations };
  }
  function checkGrants(grants: readonly CancellationEnvelope[], replacement: string, destinations: readonly string[]) {
    for (const grant of grants) {
      const p = parseForumAuthority(grant.kind, JSON.parse(grant.recordJson));
      if (!p || (p.kind !== "see" && p.kind !== "post") ||
          p.row.accessor !== replacement || !destinations.includes(p.row.object)) throw Error("replacement grant outside intent");
    }
  }
  async function load(operationId: string, replacement: string): Promise<ReplacementGrantPlan | null> {
    const before = await binding(operationId, replacement), text = await input.store.read(operationId);
    let plan: ReplacementGrantPlan | null = null;
    if (text !== null) {
      if (typeof text !== "string" || bytes(text) > cap) throw Error("invalid replacement document");
      const r = recoveryObject(JSON.parse(text));
      if (!r || Object.keys(r).sort().join() !== "grants,operationDigest,operationId,version" ||
          r.version !== 1 || r.operationId !== operationId || r.operationDigest !== before.digest) throw Error("replacement binding mismatch");
      const grants = snapshotGrants(r.grants);
      checkGrants(grants, replacement, before.destinations);
      plan = Object.freeze({ version: 1, operationId, operationDigest: before.digest, grants });
    }
    if ((await binding(operationId, replacement)).digest !== before.digest) throw Error("reassignment changed during recovery");
    return plan;
  }
  return Object.freeze({ load,
    async prepare(operationId: string, replacement: string, records: readonly CancellationEnvelope[]): Promise<ReplacementGrantPlan> {
      const grants = snapshotGrants(records); // Before the first await.
      const bound = await binding(operationId, replacement);
      checkGrants(grants, replacement, bound.destinations);
      const plan: ReplacementGrantPlan = { version: 1, operationId, operationDigest: bound.digest, grants };
      const text = JSON.stringify(plan);
      if (bytes(text) > cap) throw Error("replacement outbox capacity");
      await input.store.create(operationId, text);
      const saved = await load(operationId, replacement);
      if (!saved || JSON.stringify(saved) !== text) throw Error("replacement outbox conflict or missing durable write");
      return saved;
    },
  });
}
