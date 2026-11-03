import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { recoveryObject, recoveryList } from "./identity/forum-recovery-records";
import { isForumObjectId, isSeaPubkey } from "./identity/forum-check";

/** Storage must implement linearizable create-if-absent and durable reads.
 * A Gun put acknowledgement or browser-local map does not meet this contract.
 * Never overwrite/delete an operation: a lost response must not mint new records.
 */
export type CancellationOutboxStore = {
  read(operationId: string): Promise<string | null>;
  create(operationId: string, exactDocument: string): Promise<void>;
};
export type CancellationEnvelope = Readonly<{ kind: AuthorityKind; soul: string; recordJson: string }>;
export type CancellationOperation = Readonly<{
  operationId: string; forum: string; agent: string; fence: string;
  cancellations: readonly CancellationEnvelope[];
}>;
const MAX_BYTES = 1_048_576, MAX_RECORDS = 256;
const operationId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
const bytes = (v: string) => new TextEncoder().encode(v).length;
export function snapshotCancellationOperation(input: unknown): CancellationOperation {
  const r = recoveryObject(input), list = r && recoveryList(r.cancellations);
  if (!r || Object.keys(r).sort().join() !== "agent,cancellations,fence,forum,operationId" ||
      !operationId(r.operationId) || typeof r.forum !== "string" || !isForumObjectId(r.forum, "forum") ||
      typeof r.agent !== "string" || !isSeaPubkey(r.agent) || typeof r.fence !== "string" ||
      !r.fence.length || r.fence.length > 256 || !list?.length || list.length > MAX_RECORDS) throw Error("invalid cancellation operation");
  const seen = new Set<string>();
  const cancellations = list.map(raw => {
    const row = recoveryObject(raw);
    if (!row || Object.keys(row).sort().join() !== "kind,recordJson,soul" ||
        typeof row.kind !== "string" || !["see", "post", "membership", "object-set", "cancel"].includes(row.kind) ||
        typeof row.recordJson !== "string" || bytes(row.recordJson) > 32768 || typeof row.soul !== "string") throw Error("invalid cancellation envelope");
    const parsed = parseForumAuthority(row.kind as AuthorityKind, JSON.parse(row.recordJson));
    if (!parsed?.cancellation || parsed.soul !== row.soul) throw Error("not a cancellation at this soul");
    const identity = JSON.stringify([row.kind, row.soul, row.recordJson]);
    if (seen.has(identity)) throw Error("duplicate cancellation");
    seen.add(identity);
    return Object.freeze({ kind: row.kind as AuthorityKind, soul: row.soul, recordJson: row.recordJson });
  });
  return Object.freeze({ operationId: r.operationId, forum: r.forum, agent: r.agent, fence: r.fence,
    cancellations: Object.freeze(cancellations) });
}

/** Immutable retry material only. Parsing proves neither signature validity nor
 * owner authority, inventory completeness, fencing, durable ACL cancellation,
 * or permission to issue replacement grants. No publication/completion API exists.
 * The future coordinator must verify those facts independently on every retry.
 */
export function createCancellationOutbox(store: CancellationOutboxStore) {
  async function load(id: string): Promise<CancellationOperation | null> {
    if (!operationId(id)) throw Error("invalid operation ID");
    const text = await store.read(id);
    if (text === null) return null;
    if (typeof text !== "string" || bytes(text) > MAX_BYTES) throw Error("invalid outbox document");
    const saved = snapshotCancellationOperation(JSON.parse(text));
    if (saved.operationId !== id) throw Error("outbox operation mismatch");
    return saved;
  }
  return Object.freeze({ load,
    async prepare(input: CancellationOperation): Promise<CancellationOperation> {
      // Snapshot before any await; recordJson preserves signature/attestation bytes.
      const requested = snapshotCancellationOperation(input), text = JSON.stringify(requested);
      if (bytes(text) > MAX_BYTES) throw Error("outbox capacity");
      await store.create(requested.operationId, text);
      const saved = await load(requested.operationId);
      if (!saved || JSON.stringify(saved) !== text) throw Error("outbox conflict or missing durable write");
      return saved;
    },
  });
}
