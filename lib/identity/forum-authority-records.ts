/** P-256 wire contracts copied/retyped from SociACL b7f9bc59
 * typescript/ids/src/records.js and typescript/src/group.js. No admission here. */
import { grantSoul } from "./acl-souls";
import { seaToPrincipalKey, seaFromPrincipalKey } from "./forum-check";
import { parseForumObjectRecord } from "./forum-object-record";
import { recoveryObject, recoveryList, recoveryInteger, recoveryBytes } from "./forum-recovery-records";
export type AuthorityKind = "object" | "see" | "post" | "membership" | "object-set" | "cancel";
export type GroupPredicate = "same-group" | "named-circle";
type Proof = { issuedAt: number; sig: string; attest?: string };
export type DirectGrant = Proof & { owner: string; object: string; accessor: string; stated: 0 | 1; from: number; until: number; hamState: number };
export type Membership = Proof & { role: "member" | "set"; predicate: GroupPredicate; set: string; member: string; setOwner: string; stated: 0 | 1; hamState: number; cancels: readonly string[] };
export type ObjectSet = Proof & { owner: string; object: string; predicate: GroupPredicate; set: string; stated: 0 | 1; hamState: number; cancels: readonly string[] };
export type GroupCancel = Proof & { kind: "membership" | "object-set"; rowSoul: string; cancelId: string; prior: readonly string[]; signer: string; predicate: GroupPredicate; set: string; member: string; setOwner: string; object?: string };
export type AuthorityRecord =
  | { kind: "object"; row: NonNullable<ReturnType<typeof parseForumObjectRecord>>["record"] }
  | { kind: "see" | "post"; row: Readonly<DirectGrant> }
  | { kind: "membership"; row: Readonly<Membership> }
  | { kind: "object-set"; row: Readonly<ObjectSet> }
  | { kind: "cancel"; row: Readonly<GroupCancel> };
export type ParsedAuthority = AuthorityRecord & { soul: string; bytes: Uint8Array; signer: string; cancellation: boolean };
export function objectPrincipal(object: unknown): string | null {
  if (typeof object !== "string") return null;
  const m = /^([a-z][a-z0-9]{1,15})_(p_[0-9a-f]{128})_[0-9a-f]{32}$/.exec(object);
  return m && !["claim", "ext", "post", "member", "objset"].includes(m[1]) ? seaFromPrincipalKey(m[2]) : null;
}
// Object admission is addressed by the canonical object ID, not a new Gun root.
// The transport adapter must extract this target from its subscribed location.
export const objectRecordSoul = (object: string) => object;
export function directGrantSoul(kind: "see" | "post", owner: string, object: string, accessor: string): string | null {
  const see = grantSoul(owner, object, accessor);
  if (!see) return null;
  if (kind === "see") return see;
  if (kind !== "post") return null;
  const parts = see.split("/");
  parts.splice(3, 0, "post");
  return parts.join("/");
}
export const membershipRecordSoul = (r: Pick<Membership, "setOwner" | "predicate" | "set" | "member">) =>
  `s3rch/acl/${seaToPrincipalKey(r.setOwner)}/member/${r.predicate}/${r.set}/${seaToPrincipalKey(r.member)}`;
export const objectSetRecordSoul = (r: Pick<ObjectSet, "owner" | "object" | "predicate" | "set">) =>
  `s3rch/acl/${seaToPrincipalKey(r.owner)}/objset/${r.predicate}/${r.set}/${r.object}`;
function ids(input: unknown): readonly string[] | null {
  const list = recoveryList(input);
  return list && list.every((x, i) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x) && (!i || String(list[i - 1]) < x)) ? Object.freeze(list as string[]) : null;
}
const principal = (x: unknown): x is string => typeof x === "string" && !!seaToPrincipalKey(x);
const predicate = (x: unknown): x is GroupPredicate => x === "same-group" || x === "named-circle";
const stated = (x: unknown): x is 0 | 1 => Object.is(x, 0) || Object.is(x, 1);
export function parseForumAuthority(kind: AuthorityKind, input: unknown): ParsedAuthority | null {
  if (kind === "object") {
    const p = parseForumObjectRecord(input);
    return p ? { kind, row: p.record, bytes: p.bytes, soul: objectRecordSoul(p.record.object), signer: p.record.owner, cancellation: false } : null;
  }
  const r = recoveryObject(input);
  if (!r || !recoveryInteger(r.issuedAt) || typeof r.sig !== "string" || !r.sig.length || r.sig.length > 128 ||
    (Object.hasOwn(r, "attest") && (typeof r.attest !== "string" || !r.attest.length || r.attest.length > 16384))) return null;
  const proof = { issuedAt: r.issuedAt, sig: r.sig, ...(typeof r.attest === "string" ? { attest: r.attest } : {}) };
  if (kind === "see" || kind === "post") {
    const domain = `sociacl-${kind}-grant-v2`;
    if ((r.domain !== undefined && r.domain !== domain) || !principal(r.owner) || objectPrincipal(r.object) !== r.owner || !principal(r.accessor) ||
      !stated(r.stated) || !recoveryInteger(r.from) || !recoveryInteger(r.until) || r.until < r.from || !recoveryInteger(r.hamState)) return null;
    const row: Readonly<DirectGrant> = Object.freeze({ ...proof, owner: r.owner, object: r.object as string, accessor: r.accessor, stated: r.stated, from: r.from, until: r.until, hamState: r.hamState });
    const soul = directGrantSoul(kind, row.owner, row.object, row.accessor);
    if (!soul) return null;
    return { kind, row, signer: row.owner, cancellation: !row.stated, soul,
      bytes: recoveryBytes([domain, row.owner, row.object, row.accessor, String(row.stated), String(row.from), String(row.until), String(row.hamState), String(row.issuedAt)]) };
  }
  if (!predicate(r.predicate) || typeof r.set !== "string" || !r.set.startsWith("set_") || !objectPrincipal(r.set)) return null;
  if (kind === "membership") {
    const domain = "sociacl-membership-assent-v2", cancels = ids(r.cancels);
    if ((r.domain !== undefined && r.domain !== domain) || !cancels || !principal(r.member) || !principal(r.setOwner) || objectPrincipal(r.set) !== r.setOwner ||
      (r.role !== "member" && r.role !== "set") || !stated(r.stated) || !recoveryInteger(r.hamState)) return null;
    const row: Readonly<Membership> = Object.freeze({ ...proof, role: r.role, predicate: r.predicate, set: r.set, member: r.member, setOwner: r.setOwner, stated: r.stated, hamState: r.hamState, cancels });
    return { kind, row, signer: row.role === "member" ? row.member : row.setOwner, cancellation: !row.stated, soul: membershipRecordSoul(row),
      bytes: recoveryBytes([domain, row.role, row.predicate, row.set, row.member, row.setOwner, String(row.stated), String(row.hamState), String(row.issuedAt), String(cancels.length), ...cancels]) };
  }
  if (kind === "object-set") {
    const domain = "sociacl-object-set-v2", cancels = ids(r.cancels);
    if ((r.domain !== undefined && r.domain !== domain) || !cancels || !principal(r.owner) || objectPrincipal(r.object) !== r.owner || !stated(r.stated) || !recoveryInteger(r.hamState)) return null;
    const row: Readonly<ObjectSet> = Object.freeze({ ...proof, owner: r.owner, object: r.object as string, predicate: r.predicate, set: r.set, stated: r.stated, hamState: r.hamState, cancels });
    return { kind, row, signer: row.owner, cancellation: !row.stated, soul: objectSetRecordSoul(row),
      bytes: recoveryBytes([domain, row.owner, row.object, row.predicate, row.set, String(row.stated), String(row.hamState), String(row.issuedAt), String(cancels.length), ...cancels]) };
  }
  if (kind === "cancel") {
    const domain = "sociacl-cancel-v2", prior = ids(r.prior);
    if ((r.domain !== undefined && r.domain !== domain) || !prior || !principal(r.member) || !principal(r.setOwner) || objectPrincipal(r.set) !== r.setOwner || !principal(r.signer) ||
      typeof r.cancelId !== "string" || !/^[0-9a-f]{64}$/.test(r.cancelId) || prior.includes(r.cancelId) || typeof r.rowSoul !== "string") return null;
    let soul: string;
    if (r.kind === "membership") {
      if (r.signer !== r.member && r.signer !== r.setOwner) return null;
      soul = membershipRecordSoul({ setOwner: r.setOwner, predicate: r.predicate, set: r.set, member: r.member });
    } else if (r.kind === "object-set" && objectPrincipal(r.object) === r.signer) {
      soul = objectSetRecordSoul({ owner: r.signer, object: r.object as string, predicate: r.predicate, set: r.set });
    } else return null;
    if (r.rowSoul !== soul) return null;
    const row: Readonly<GroupCancel> = Object.freeze({ ...proof, kind: r.kind, rowSoul: soul, cancelId: r.cancelId, prior, signer: r.signer,
      predicate: r.predicate, set: r.set, member: r.member, setOwner: r.setOwner, ...(r.kind === "object-set" ? { object: r.object as string } : {}) });
    return { kind, row, signer: row.signer, cancellation: true, soul,
      bytes: recoveryBytes([domain, row.kind, row.rowSoul, row.cancelId, String(row.issuedAt), String(prior.length), ...prior]) };
  }
  return null;
}
