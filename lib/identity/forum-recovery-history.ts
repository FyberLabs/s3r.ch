import { seaToPrincipalKey } from "./forum-check";
import { parseForumRotationCandidate, type UnverifiedForumRotation } from "./forum-rotation-record";
import { verifyForumRotationWitness } from "./forum-rotation-witness";
import { verifyForumRotationProofBinding } from "./forum-rotation-proof-binding";
import { parseForumWalletLinkRecord, type UnverifiedForumWalletLink } from "./forum-wallet-link-record";
import { verifyForumWalletLinkWitness } from "./forum-wallet-link-proof";
import { parseForumRevoke } from "./forum-revocation";
import { checkForumLinkRevocations } from "./forum-link-revocations";
import { verifyForumKeySignature } from "./forum-key-signature";
import { verifyForumSiwe, type ForumSiwePolicy } from "./forum-siwe";
import type { ForumWitnessKey } from "./forum-witness-verification";
import { createForumLinkKeyResolver, type AuthenticatedForumLinkHistory } from "./forum-link-retention";
import type { ForumRecoveryProvider } from "./forum-wallet-eligibility";
import { recoveryInteger, recoveryObject, recoveryList, recoveryId, parseForumRecoveryRecord, verifyForumRecoveryWitness,
  type ForumOidcLink, type ForumGenesisEpub } from "./forum-recovery-records";

/** TRUSTED TRANSPORT CONTRACT, not an assertion accepted from a mesh peer.
 * The source must supply complete account histories/revocations and the global
 * candidate index through completeThrough. Missing accounts deny; empty lists
 * must mean verified absence. Cryptography cannot prove that rows were omitted.
 * This verifier neither fetches nor certifies transport completeness (#190).
 */
export type ForumRecoverySnapshot = Readonly<{
  completeThrough: number;
  links: readonly unknown[];
  accounts: readonly Readonly<{ principal: string; rotations: readonly unknown[];
    genesisEpubBindings: readonly unknown[]; revocations: readonly unknown[] }>[];
}>;
type Reason = "bad-input" | "missing-history" | "rotation-fork" | "rotation-conflict" | "resource-limit";
type Diagnostic = Readonly<{ principal: string; source: "rotation" | "link" | "revoke" | "genesis-epub"; index: number; reason: string }>;
type Link = Readonly<{ record: UnverifiedForumWalletLink | ForumOidcLink; bytes: Uint8Array; index: number; id: string }>;
type Account = { principal: string; rotations: (ReturnType<typeof parseForumRotationCandidate>)[];
  bindings: (ReturnType<typeof parseForumRecoveryRecord>)[]; revocations: readonly unknown[] };
type Resolved = Readonly<{ history: AuthenticatedForumLinkHistory; currentKey: string; currentEpub: string | null; bindingEpub: string | null }>;
class Denied extends Error { constructor(readonly reason: Reason) { super(reason); } }

/** Authenticate raw recovery history, then expose an exact-time provider for
 * existing ownership/eligibility consumers. No network, ambient keys, durable
 * cache, or sample ACL fallback. Consumer implementation of SociACL b7f9bc59
 * resolveCurrentKey/checkRotateBody, with issuance-key revocation verification.
 */
export async function resolveForumRecoveryHistory(
  principal: string, input: ForumRecoverySnapshot, trustedKeys: readonly ForumWitnessKey[],
  policyInput: ForumSiwePolicy, pinnedIssuers: readonly string[], at: number,
) {
  const diagnostics: Diagnostic[] = [];
  const reported = new Set<string>();
  const report = (owner: string, source: Diagnostic["source"], index: number, reason: string) => {
    const key = [owner, source, index, reason].join(":");
    if (!reported.has(key)) { reported.add(key); diagnostics.push(Object.freeze({ principal: owner, source, index, reason })); }
  };
  const fail = (reason: Reason): never => { throw new Denied(reason); };
  try {
    if (typeof principal !== "string" || !seaToPrincipalKey(principal) || !recoveryInteger(at)) fail("bad-input");
    const supplied = recoveryObject(input);
    if (!supplied || !recoveryInteger(supplied.completeThrough) || supplied.completeThrough < at) return Object.freeze({ ok: false as const, reason: "missing-history" as const, diagnostics: Object.freeze(diagnostics) });
    const list = (x: unknown) => recoveryList(x) ?? fail("bad-input");
    const object = (x: unknown) => recoveryObject(x) ?? fail("bad-input");
    // Snapshot every record and all policy before the first await. Accessors are
    // never invoked, even for array slots; malformed evidence is diagnostic.
    const p = object(policyInput);
    const strings = (x: unknown) => list(x).map(v => typeof v === "string" && v.length <= 2048 ? v : fail("bad-input"));
    const skew = p.clockSkewSeconds ?? 0;
    if (!recoveryInteger(skew) || skew > 300) fail("bad-input");
    const policy: ForumSiwePolicy = { allowedDomains: strings(p.allowedDomains), allowedUris: strings(p.allowedUris), allowedChainIds: strings(p.allowedChainIds), clockSkewSeconds: skew as number };
    const issuers = strings(pinnedIssuers);
    const keys = list(trustedKeys).map(raw => {
      const k = object(raw);
      if (k.key_ops !== undefined) k.key_ops = strings(k.key_ops);
      return k as unknown as ForumWitnessKey;
    });
    const rawLinks = list(supplied.links).map(raw => {
      const wallet = parseForumWalletLinkRecord(raw);
      if (wallet) return wallet;
      const other = parseForumRecoveryRecord(raw);
      return other?.record.kind === "oidc" ? { record: other.record, bytes: other.bytes } : null;
    });
    const accounts = new Map<string, Account>();
    let size = rawLinks.length, retainedCount = 0;
    for (const raw of list(supplied.accounts)) {
      const a = object(raw);
      if (typeof a.principal !== "string" || !seaToPrincipalKey(a.principal) || accounts.has(a.principal)) fail("bad-input");
      const owner = a.principal as string;
      const rotations = list(a.rotations).map(parseForumRotationCandidate);
      const bindings = list(a.genesisEpubBindings).map(parseForumRecoveryRecord);
      const revocations = Object.freeze(list(a.revocations).map(r => parseForumRevoke(r)?.record ?? null));
      size += rotations.length + bindings.length + revocations.length + 1;
      retainedCount += rotations.reduce((n, r) => n + (r?.record.retainedLinks.length ?? 0), 0);
      if (size > 4096 || accounts.size >= 128 || retainedCount > 65536) fail("resource-limit");
      accounts.set(owner, { principal: owner, rotations, bindings, revocations });
    }
    if (!accounts.has(principal)) fail("missing-history");
    const links: Link[] = [];
    for (const [index, p] of rawLinks.entries()) {
      if (!p) { report(principal, "link", index, "bad-record"); continue; }
      links.push({ ...p, index, id: await recoveryId(p.bytes) });
    }
    const byId = new Map<string, Link[]>();
    for (const link of links) { const copies = byId.get(link.id) ?? []; copies.push(link); byId.set(link.id, copies); }
    const independent = new Map<number, boolean>();
    let work = 0;
    const spend = (amount = 1) => { work += amount; if (work > 16384) fail("resource-limit"); };
    const memo = new Map<string, Resolved>();
    const active = new Set<string>();
    const project = (owner: string, horizon: number, rows: readonly UnverifiedForumRotation[]): AuthenticatedForumLinkHistory => Object.freeze({
      owner, evaluatedAt: horizon, rotations: Object.freeze(rows.map(r => Object.freeze({ seq: r.seq, prevKey: r.prevKey, nextKey: r.nextKey, issuedAt: r.issuedAt, retainedLinks: r.retainedLinks }))),
    });
    async function witness(link: Link): Promise<boolean> {
      if (independent.has(link.index)) return independent.get(link.index)!;
      spend();
      const r = link.record;
      const good = r.kind === "wallet" ? !!await verifyForumWalletLinkWitness(r, keys, policy, r.issuedAt) : verifyForumRecoveryWitness(r, keys, issuers);
      independent.set(link.index, good);
      return good;
    }
    async function eligible(link: Link, owner: string, history: readonly UnverifiedForumRotation[], horizon: number): Promise<"valid" | "invalid" | "revoked"> {
      spend(); const r = link.record;
      // Authenticate independent evidence before accessing a foreign principal.
      if (r.issuedAt > horizon || !await witness(link)) { report(r.principal, "link", link.index, "bad-proof"); return "invalid"; }
      const projection = r.principal === owner ? project(owner, horizon, history) : (await resolve(r.principal, horizon)).history;
      const state = createForumLinkKeyResolver(() => projection)(r.principal, r.issuedAt, horizon);
      if (!state) return fail("missing-history");
      if (!verifyForumKeySignature(state.keyAtIssuedAt, r.keySig, link.bytes) || (state.retainedLinks !== null && !state.retainedLinks.includes(link.id))) {
        report(r.principal, "link", link.index, "bad-proof-or-retention"); return "invalid";
      }
      const a = accounts.get(r.principal) ?? fail("missing-history");
      spend(a.revocations.length);
      const revokes = await checkForumLinkRevocations({ principal: r.principal, linkId: link.id, issuedAt: r.issuedAt }, a.revocations,
        state.currentKey, keys, horizon, "historical", t => projection.rotations.filter(r => r.issuedAt < t).at(-1)?.nextKey ?? r.principal);
      if (!revokes.ok) return fail("missing-history");
      for (const d of revokes.diagnostics) report(r.principal, "revoke", d.index, d.reason);
      return revokes.revoked ? "revoked" : "valid";
    }
    async function transition(r: UnverifiedForumRotation, owner: string, history: readonly UnverifiedForumRotation[]): Promise<void> {
      if (!await verifyForumRotationProofBinding(r, keys, r.issuedAt)) fail("missing-history");
      const checked = new Map<string, Link>();
      for (const id of new Set([r.authorizer.link, ...r.retainedLinks])) {
        let valid: Link | undefined, revoked = false;
        for (const link of byId.get(id) ?? []) {
          if (link.record.principal !== owner) continue;
          const status = await eligible(link, owner, history, r.issuedAt);
          if (status === "valid") valid = link;
          if (status === "revoked") revoked = true;
        }
        if (!valid) fail(revoked ? "rotation-conflict" : "missing-history");
        checked.set(id, valid!);
      }
      const authorizer = checked.get(r.authorizer.link)!;
      if (r.authorizer.kind === "wallet") {
        if (authorizer.record.kind !== "wallet") return fail("missing-history");
        const bytes = parseForumRotationCandidate(r)!.bytes;
        if (!await verifyForumSiwe(authorizer.record.address, r.authorizer.siwe.message, r.authorizer.siwe.signature, bytes, r.issuedAt, r.issuedAt, policy)) fail("missing-history");
        // Select across the complete address index, including other principals.
        const candidates = new Map<string, Link>();
        for (const link of links) if (link.record.kind === "wallet" && link.record.address === authorizer.record.address && await eligible(link, owner, history, r.issuedAt) === "valid") candidates.set(link.id, link);
        const newest = Math.max(...Array.from(candidates.values(), l => l.record.issuedAt));
        const winners = [...candidates.values()].filter(l => l.record.issuedAt === newest);
        if (winners.length !== 1 || winners[0].id !== r.authorizer.link) fail("rotation-conflict");
      } else {
        if (authorizer.record.kind !== "oidc") fail("missing-history");
        // The exact rotation witness certifies the fresh OIDC login. An OIDC
        // link alone does not permit fallback while any own wallet is active.
        for (const link of links) if (link.record.kind === "wallet" && link.record.principal === owner && await eligible(link, owner, history, r.issuedAt) === "valid") fail("rotation-conflict");
      }
    }
    async function resolve(owner: string, horizon: number): Promise<Resolved> {
      spend();
      const cacheKey = owner + ":" + horizon;
      const cached = memo.get(cacheKey); if (cached) return cached;
      if (active.has(cacheKey) || active.size >= 64) return fail("missing-history");
      const a = accounts.get(owner) ?? fail("missing-history");
      active.add(cacheKey);
      try {
        const bindings = new Map<string, { record: ForumGenesisEpub; index: number }>();
        for (const [index, p] of a.bindings.entries()) {
          spend();
          if (!p || p.record.kind !== "genesis-epub" || p.record.principal !== owner || p.record.issuedAt > horizon || !verifyForumRecoveryWitness(p.record, keys, issuers)) {
            report(owner, "genesis-epub", index, "bad-proof"); continue;
          }
          bindings.set(await recoveryId(p.bytes), { record: p.record, index });
        }
        const groups = new Map<number, { record: UnverifiedForumRotation; bytes: Uint8Array; index: number }[]>();
        for (const [index, p] of a.rotations.entries()) {
          spend();
          if (!p || p.record.principal !== owner) { report(owner, "rotation", index, "bad-record"); continue; }
          if (p.record.issuedAt > horizon) { report(owner, "rotation", index, "future-record"); continue; }
          if (!verifyForumRotationWitness(p.record, keys, horizon)) { report(owner, "rotation", index, "bad-proof"); continue; }
          const group = groups.get(p.record.seq) ?? []; group.push({ record: p.record, bytes: p.bytes, index }); groups.set(p.record.seq, group);
        }
        const history: UnverifiedForumRotation[] = [];
        let current = owner, currentEpub: string | null = null, bindingEpub: string | null = null;
        for (const [seq, group] of [...groups].sort((a, b) => a[0] - b[0])) {
          const valid = new Map<string, UnverifiedForumRotation>(), unresolved = new Map<string, Reason>();
          for (const { record: r, bytes, index } of group) {
            spend(); const id = await recoveryId(bytes);
            try {
              if (seq !== history.length + 1) fail("missing-history");
              const early = [...bindings.values()].filter(b => b.record.issuedAt < (history[0]?.issuedAt ?? r.issuedAt));
              const oldEpubs = [...early.map(b => b.record.epub), ...history.flatMap(h => h.nextEpub ? [h.nextEpub] : [])];
              const signingKeys = [owner, ...history.map(h => h.nextKey)];
              if (r.issuedAt <= (history.at(-1)?.issuedAt ?? -1) || r.prevKey !== current || signingKeys.includes(r.nextKey) || oldEpubs.includes(r.nextKey) ||
                (r.nextEpub !== undefined && (r.nextEpub === r.nextKey || signingKeys.includes(r.nextEpub) || oldEpubs.includes(r.nextEpub)))) fail("rotation-conflict");
              await transition(r, owner, history);
              valid.set(id, r);
            } catch (error) {
              if (!(error instanceof Denied)) throw error;
              if (error.reason === "resource-limit") throw error;
              report(owner, "rotation", index, error.reason); unresolved.set(id, error.reason);
            }
          }
          // A damaged duplicate must not veto a valid copy of its signed ID.
          // Distinct authenticated unresolved transitions must never disappear.
          if (valid.size > 1) fail("rotation-fork");
          for (const [id, reason] of unresolved) if (!valid.has(id)) fail(reason);
          const next = [...valid.values()][0];
          if (next) {
            if (!history.length) {
              const early = [...bindings.values()].filter(b => b.record.issuedAt < next.issuedAt);
              for (const b of bindings.values()) if (b.record.issuedAt >= next.issuedAt) report(owner, "genesis-epub", b.index, "bad-sequence");
              if (early.length > 1) fail("rotation-fork");
              bindingEpub = early[0]?.record.epub ?? null;
            }
            history.push(next); current = next.nextKey; currentEpub = next.nextEpub ?? null;
          }
        }
        if (!history.length) {
          if (bindings.size > 1) fail("rotation-fork");
          bindingEpub = [...bindings.values()][0]?.record.epub ?? null; currentEpub = bindingEpub;
        }
        const result = Object.freeze({ history: project(owner, horizon, history), currentKey: current, currentEpub, bindingEpub });
        memo.set(cacheKey, result); return result;
      } finally { active.delete(cacheKey); }
    }
    const result = await resolve(principal, at);
    const revocations = accounts.get(principal)!.revocations;
    // Only the requested, fully resolved principal/time is exposed. Never
    // extrapolate from a successful historical lookup to present authority.
    const provider: ForumRecoveryProvider = (owner, now) => owner === principal && now === at ? Object.freeze({ history: result.history, revocations }) : null;
    return Object.freeze({ ok: true as const, ...result, provider, diagnostics: Object.freeze(diagnostics) });
  } catch (error) {
    return Object.freeze({ ok: false as const, reason: error instanceof Denied ? error.reason : "bad-input" as const, diagnostics: Object.freeze(diagnostics) });
  }
}
