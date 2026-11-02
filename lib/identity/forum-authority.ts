import type { SeeGraph, CheckResult } from "./check";
import { createForumKeyResolver } from "./forum-history-adapter";
import { resolveForumRecoveryHistory, type ForumRecoverySnapshot } from "./forum-recovery-history";
import { verifyForumKeySignature } from "./forum-key-signature";
import { verifyForumWitness, type ForumWitnessKey } from "./forum-witness-verification";
import type { ForumKeyResolver } from "./forum-object-verification";
import type { ForumSiwePolicy } from "./forum-siwe";
import { recoveryObject, recoveryList, recoveryInteger, recoveryId } from "./forum-recovery-records";
import { parseForumAuthority, objectPrincipal, directGrantSoul, membershipRecordSoul,
  type AuthorityKind, type ParsedAuthority } from "./forum-authority-records";

/** Complete signed ACL evidence, including cancellations, from the trusted
 * source contract in #190. `soul` is the transport-observed grant address, or
 * the canonical target object ID for an ownership record. Never use a row's
 * self-declared soul as its transport address. Legacy snapshots are not input. */
export type ForumAuthoritySnapshot = Readonly<{
  completeThrough: number;
  history: ForumRecoverySnapshot;
  rows: readonly Readonly<{ kind: AuthorityKind; soul: string; record: unknown }>[];
}>;
export type ForumAuthorityConfig = Readonly<{ keys: readonly ForumWitnessKey[]; policy: ForumSiwePolicy; pinnedIssuers: readonly string[] }>;
export type ForumAuthorityGraph = SeeGraph & {
  writerKey(principal: string, issuedAt: number, now: number): string | null;
  principalForKey(key: string, now: number): string | null;
  ownedObjects(owner: string): readonly string[];
  checkDirectSee(object: string, accessor: string, now: number): CheckResult;
  checkForumSee(object: string, accessor: string, now: number): CheckResult;
  checkPost(object: string, accessor: string, now: number): CheckResult;
};
type Diagnostic = Readonly<{ index: number; reason: string }>;
const denied = (reason = "missing-authority"): CheckResult => ({ allowed: false, reason });
/** Deterministic signed HAM merge: higher state, cancellation, smaller bytes. */
function wins(next: ParsedAuthority, prev: ParsedAuthority | undefined): boolean {
  if (!prev) return true;
  if (!("hamState" in next.row) || !("hamState" in prev.row)) return next.row.issuedAt > prev.row.issuedAt;
  if (next.row.hamState !== prev.row.hamState) return next.row.hamState > prev.row.hamState;
  if (next.row.stated !== prev.row.stated) return next.row.stated === 0;
  for (let i = 0; i < Math.min(next.bytes.length, prev.bytes.length); i++) if (next.bytes[i] !== prev.bytes[i]) return next.bytes[i] < prev.bytes[i];
  return next.bytes.length < prev.bytes.length;
}

/** A separate read-only authority graph: no putObject/stateSeeGrant or legacy
 * restore API. Refresh clears old authority before awaiting proofs. Every read
 * checks the exact evaluation second; expiry, missing refresh and superseded
 * in-flight refreshes deny. Consumers must refresh from complete source data.
 */
export function createForumAuthority(config: ForumAuthorityConfig, clock: () => number = () => Math.floor(Date.now() / 1000)) {
  let generation = 0;
  let state: { at: number; owners: Map<string, string>; rows: Map<string, ParsedAuthority>; cancels: Map<string, Set<string>>; resolver: ForumKeyResolver; principals: readonly string[] } | null = null;
  const listeners = new Set<() => void>();
  const notify = () => { for (const fn of listeners) fn(); };
  const current = (now = clock()) => recoveryInteger(now) && state?.at === now && clock() === now ? state : null;
  const ownerOf = (object: string) => current()?.owners.get(object);
  function direct(kind: "see" | "post", object: string, accessor: string, now: number): CheckResult {
    const s = current(now), owner = s?.owners.get(object);
    if (!s) return denied();
    if (!owner || !objectPrincipal(object)) return denied("missing-object");
    if (accessor === owner) return { allowed: true, reason: "owner" };
    const p = s.rows.get(directGrantSoul(kind, owner, object, accessor));
    if (!p || (p.kind !== "see" && p.kind !== "post") || p.row.owner !== owner || p.row.accessor !== accessor || p.row.object !== object ||
      p.row.stated !== 1) return denied(p ? "denied" : "missing-grant");
    if (now < p.row.from) return denied("future-from");
    if (now >= p.row.until) return denied("expired");
    return { allowed: true, reason: kind + "-grant" };
  }
  const graph: ForumAuthorityGraph = Object.freeze({
    hasObject: (object: string) => !!ownerOf(object), ownerOf,
    ownedObjects: (owner: string) => [...(current()?.owners ?? [])].flatMap(([id, who]) => who === owner ? [id] : []),
    writerKey(principal: string, issuedAt: number, now: number) {
      if (!recoveryInteger(issuedAt) || issuedAt > now) return null;
      const key = current(now)?.resolver(principal, issuedAt, now);
      return key && key.keyAtIssuedAt === key.currentKey ? key.currentKey : null;
    },
    principalForKey(key: string, now: number) {
      const s = current(now); if (!s) return null;
      const matches = s.principals.filter(p => s.resolver(p, now, now)?.currentKey === key);
      return matches.length === 1 ? matches[0] : null;
    },
    // Legacy Check gets only verified DIRECT grants. Group access must never
    // accidentally confer direct child-write authority.
    seeGrants(object: string) {
      const s = current(), owner = s?.owners.get(object);
      if (!s || !owner) return [];
      return [...s.rows.values()].flatMap(p => p.kind === "see" && p.row.object === object && p.row.owner === owner && p.row.stated === 1
        ? [Object.freeze({ claimId: object, accessor: p.row.accessor, from: p.row.from, until: p.row.until })] : []);
    },
    checkDirectSee: (object: string, accessor: string, now: number) => direct("see", object, accessor, now),
    checkPost: (object: string, accessor: string, now: number) => direct("post", object, accessor, now),
    checkForumSee(object: string, accessor: string, now: number): CheckResult {
      const read = direct("see", object, accessor, now); if (read.allowed) return read;
      const s = current(now), owner = s?.owners.get(object); if (!s || !owner) return read;
      const edge = s.rows.get("object-set:" + object);
      if (!edge || edge.kind !== "object-set" || edge.row.owner !== owner) return read;
      if (edge.row.stated !== 1) return denied("denied");
      const covers = (p: ParsedAuthority) => "cancels" in p.row && [...(s.cancels.get(p.soul) ?? [])].every(id => (p.row as { cancels: readonly string[] }).cancels.includes(id));
      if (!covers(edge)) return denied("denied");
      const setOwner = objectPrincipal(edge.row.set); if (!setOwner) return denied();
      const soul = membershipRecordSoul({ setOwner, set: edge.row.set, predicate: edge.row.predicate, member: accessor });
      const member = s.rows.get(soul + ":member"), set = s.rows.get(soul + ":set");
      if (!member || !set || member.kind !== "membership" || set.kind !== "membership" || member.row.member !== accessor || set.row.setOwner !== setOwner ||
        member.row.stated !== 1 || set.row.stated !== 1 || !covers(member) || !covers(set)) return denied(!member || !set ? "missing-grant" : "denied");
      return { allowed: true, reason: edge.row.predicate };
    },
  });
  return Object.freeze({ graph,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    invalidate() { generation++; state = null; notify(); },
    async refresh(input: ForumAuthoritySnapshot, at: number) {
      const token = ++generation; state = null; notify();
      const diagnostics: Diagnostic[] = [];
      const fail = (reason: string) => Object.freeze({ ok: false as const, reason, diagnostics: Object.freeze(diagnostics) });
      try {
        const snapshot = recoveryObject(input), rows = snapshot && recoveryList(snapshot.rows);
        if (!snapshot || !rows || !recoveryInteger(at) || at !== clock() || !recoveryInteger(snapshot.completeThrough) || snapshot.completeThrough < at) return fail("incomplete-authority");
        const parsed = rows.map((raw, index) => {
          const e = recoveryObject(raw);
          const p = e && parseForumAuthority(e.kind as AuthorityKind, e.record);
          if (!p || e!.soul !== p.soul) { diagnostics.push({ index, reason: "bad-record-or-soul" }); return null; }
          if (p.row.issuedAt > at) { diagnostics.push({ index, reason: "future-record" }); return null; }
          return { p, index };
        });
        const k = recoveryList(config.keys), policy = recoveryObject(config.policy), issuers = recoveryList(config.pinnedIssuers);
        if (!k || !policy || !issuers) return fail("bad-config");
        const keys = k.map(raw => { const r = recoveryObject(raw); if (!r) throw Error("bad-key"); return { ...r, ...(r.key_ops === undefined ? {} : { key_ops: recoveryList(r.key_ops) }) } as unknown as ForumWitnessKey; });
        const siwe = { ...policy, allowedDomains: recoveryList(policy.allowedDomains), allowedUris: recoveryList(policy.allowedUris), allowedChainIds: recoveryList(policy.allowedChainIds) } as unknown as ForumSiwePolicy;
        const signers = [...new Set(parsed.flatMap(r => r ? [r.p.signer] : []))];
        if (signers.length > 32) return fail("capacity");
        // Start all resolvers synchronously: each snapshots history and config
        // before its first await, so later caller mutation cannot change one.
        // Roster/chat principals may have authenticated history before they
        // own a child or appear in a grant. Resolve the bounded source accounts
        // too; absent/invalid histories still have no genesis fallback.
        const history = recoveryObject(snapshot.history), accounts = history && recoveryList(history.accounts);
        const principals = [...new Set([...signers, ...parsed.flatMap(e => e && (e.p.kind === "see" || e.p.kind === "post")
          ? [e.p.row.accessor] : []), ...(accounts ?? []).flatMap(a => {
            const account = recoveryObject(a);
            return account && typeof account.principal === "string" ? [account.principal] : [];
          })])];
        if (principals.length > 128) return fail("capacity");
        const results = await Promise.all(principals.map(owner => resolveForumRecoveryHistory(owner, snapshot.history as ForumRecoverySnapshot, keys, siwe, issuers as string[], at)));
        const histories = new Map(principals.map((owner, i) => [owner, results[i]]));
        // Missing/forked authority for any evidence signer invalidates the
        // entire snapshot, including previously admitted rows/cancels.
        if (signers.some(p => !histories.get(p)?.ok)) return fail("missing-history");
        const owners = new Map<string, string>(), admitted = new Map<string, ParsedAuthority>(), cancels = new Map<string, Set<string>>();
        const cancelEvidence: Extract<ParsedAuthority, { kind: "cancel" }>[] = [];
        const resolver = createForumKeyResolver((owner, now) => {
          const result = histories.get(owner); return result?.ok && now === at ? result.history : null;
        });
        for (const entry of parsed) {
          if (!entry) continue;
          const { p, index } = entry, r = p.row;
          const key = resolver(p.signer, r.issuedAt, at);
          if (!key || !verifyForumKeySignature(key.keyAtIssuedAt, r.sig, p.bytes)) { diagnostics.push({ index, reason: "bad-proof" }); continue; }
          if (key.keyAtIssuedAt !== key.currentKey) {
            const claims = p.cancellation && "attest" in r ? verifyForumWitness(r.attest, keys, r.issuedAt) : null;
            if (!claims || Object.keys(claims).some(k => !["typ", "principal", "recordId", "iat", "exp"].includes(k)) || claims.typ !== "sociacl-acl-attest-v1" ||
              claims.principal !== p.signer || claims.iat !== r.issuedAt || claims.recordId !== await recoveryId(p.bytes)) {
              diagnostics.push({ index, reason: "retired-key" }); continue;
            }
          }
          if (p.kind === "cancel") {
            cancelEvidence.push(p);
            const held = cancels.get(p.soul) ?? new Set<string>(); held.add(p.row.cancelId); cancels.set(p.soul, held); continue;
          }
          const id = p.kind === "object-set" ? "object-set:" + p.row.object : p.kind === "membership" ? p.soul + ":" + p.row.role : p.soul;
          if (wins(p, admitted.get(id))) admitted.set(id, p);
        }
        // A complete source cannot omit cancellation predecessors. Verify the
        // dependency DAG independent of arrival order, rather than treating a
        // missing predecessor as permission to forget its cancellation.
        const priorById = new Map<string, Set<string>>();
        for (const p of cancelEvidence) {
          const key = p.soul + ":" + p.row.cancelId, prior = priorById.get(key) ?? new Set<string>();
          for (const id of p.row.prior) {
            if (!cancels.get(p.soul)?.has(id)) return fail("missing-cancellation-history");
            prior.add(p.soul + ":" + id);
          }
          priorById.set(key, prior);
        }
        const visiting = new Set<string>(), visited = new Set<string>();
        const visit = (id: string): boolean => {
          if (visited.has(id)) return true;
          if (visiting.has(id)) return false;
          visiting.add(id);
          for (const prior of priorById.get(id) ?? []) if (!visit(prior)) return false;
          visiting.delete(id); visited.add(id); return true;
        };
        for (const id of priorById.keys()) if (!visit(id)) return fail("cyclic-cancellation-history");
        for (const p of admitted.values()) if (p.kind === "object") owners.set(p.row.object, p.row.owner);
        if (generation !== token || at !== clock()) return fail("superseded");
        state = { at, owners, rows: admitted, cancels, resolver, principals }; notify();
        return Object.freeze({ ok: true as const, diagnostics: Object.freeze(diagnostics) });
      } catch { return fail("bad-input"); }
    },
  });
}
