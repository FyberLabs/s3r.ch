import type { AssignmentJournalState } from "./delegation-journal";
import type { ForumAuthorityGraph } from "./identity/forum-authority";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { recoveryId } from "./identity/forum-recovery-records";

type State = Pick<AssignmentJournalState, "owner" | "rows" | "destinations">;
export type AssignmentSigningIntent = Readonly<{ kind: AuthorityKind; soul: string; fields: Readonly<Record<string, unknown>> }>;
function intent(kind: AuthorityKind, fields: Record<string, unknown>): AssignmentSigningIntent {
  const parsed = parseForumAuthority(kind, { ...fields, sig: "pending" });
  if (!parsed) throw Error("Invalid assignment signing intent");
  for (const value of Object.values(fields)) if (Array.isArray(value)) Object.freeze(value);
  return Object.freeze({ kind, soul: parsed.soul, fields: Object.freeze(fields) });
}
function direct(state: State, kind: "see" | "post", object: string, accessor: string, stated: 0 | 1, at: number) {
  const revisions = state.rows.flatMap(row => {
    const parsed = parseForumAuthority(row.kind, row.record);
    return parsed && parsed.kind === kind && parsed.row.object === object && parsed.row.accessor === accessor ? [parsed.row.hamState] : [];
  });
  const hamState = Math.max(0, ...revisions) + 1;
  if (!Number.isSafeInteger(hamState) || !Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(at + 86400)) throw Error("Assignment signing range exhausted");
  return intent(kind, { owner: state.owner, object, accessor, stated, hamState, issuedAt: at, from: at, until: at + 86400 });
}
/** Pure plan construction from an already admitted, fixed authority snapshot.
 * This is not an admission function and never calls a signer or any store. */
export async function assignmentCancellationIntents(input: State, operationId: string, previous: string, at: number,
  graph: Pick<ForumAuthorityGraph, "groupMembership">, evaluationAt = at): Promise<readonly AssignmentSigningIntent[]> {
  if (!/^[0-9a-f]{32}$/.test(operationId)) throw Error("Invalid assignment operation");
  const state = structuredClone(input), rows: AssignmentSigningIntent[] = [];
  for (const destination of state.destinations) for (const kind of ["post", "see"] as const) rows.push(direct(state, kind, destination, previous, 0, at));
  const groups = new Map<string, NonNullable<ReturnType<ForumAuthorityGraph["groupMembership"]>>>();
  for (const destination of state.destinations) {
    const membership = graph.groupMembership(destination, previous, evaluationAt);
    if (membership) groups.set(membership.soul, { ...membership });
  }
  for (const group of groups.values()) {
    if (group.setOwner !== state.owner) throw Error("external group owner cancellation required");
    const prior = state.rows.flatMap(row => {
      const parsed = parseForumAuthority(row.kind, row.record);
      return parsed?.kind === "cancel" && parsed.soul === group.soul ? [parsed.row.cancelId] : [];
    }).sort();
    const cancelId = await recoveryId(new TextEncoder().encode(JSON.stringify(["assignment-membership-cancel-v1", operationId, group.soul])));
    rows.push(intent("cancel", { kind: "membership", rowSoul: group.soul, cancelId, prior: [...new Set(prior)],
      signer: state.owner, predicate: group.predicate, set: group.set, member: previous, setOwner: group.setOwner, issuedAt: at }));
  }
  return Object.freeze(rows);
}
export function assignmentReplacementIntents(input: State, replacement: string, at: number): readonly AssignmentSigningIntent[] {
  const state = structuredClone(input), rows: AssignmentSigningIntent[] = [];
  for (const destination of state.destinations) for (const kind of ["post", "see"] as const) rows.push(direct(state, kind, destination, replacement, 1, at));
  return Object.freeze(rows);
}
