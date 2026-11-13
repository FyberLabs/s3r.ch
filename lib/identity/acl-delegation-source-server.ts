import { historyState, linkId, parseAgentDelegation, parseAgentRevocation, parsePrincipalId,
  resolveCurrentKey, type PrincipalId, type ResolutionContext,
  type Result, type Rotate, type UnsignedRecord } from "sociacl-ids";
import { createAclGraphSource, type AclStatementConfig } from "../acl-graph-source-server";
import type { ForumRecoverySnapshot } from "./forum-recovery-history";
import type { AgentDelegationSource } from "./sea-session";

export type DelegationTrust = Pick<ResolutionContext, "jwks" | "policy" | "pinnedIss">;
const take = <T>(result: Result<T>): T => { if (!result.ok) throw Error("Invalid delegation history"); return result.value; };
const record = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid history record");
  return input as Record<string, unknown>;
};

/** Configuration supplies trust; the service supplies complete history. A service
 * snapshot cannot install witness keys or turn an omitted account into genesis. */
function contexts(snapshot: ForumRecoverySnapshot, trust: DelegationTrust, at: number) {
  if (snapshot.completeThrough !== at || !Array.isArray(snapshot.accounts) || !snapshot.accounts.length ||
      snapshot.accounts.length > 64 || !Array.isArray(snapshot.links) || snapshot.links.length > 4096) throw Error("Invalid history");
  const accounts = new Map<PrincipalId, ForumRecoverySnapshot["accounts"][number]>(snapshot.accounts.map(account => {
    const principal = take(parsePrincipalId(account.principal));
    if (!Array.isArray(account.rotations) || !Array.isArray(account.revocations) || !Array.isArray(account.genesisEpubBindings) ||
        account.rotations.length > 1024 || account.revocations.length > 1024 || account.genesisEpubBindings.length !== 1)
      throw Error("Invalid account");
    for (const row of [...account.rotations, ...account.revocations, ...account.genesisEpubBindings]) {
      const value = record(row);
      if (value.principal !== principal || !Number.isSafeInteger(value.issuedAt) || (value.issuedAt as number) > at) throw Error("Invalid account history");
    }
    return [principal, account] as const;
  }));
  if (accounts.size !== snapshot.accounts.length) throw Error("Duplicate account");
  const links = snapshot.links.map(raw => {
    const row = record(raw);
    if (!["wallet", "oidc"].includes(String(row.kind)) || !accounts.has(take(parsePrincipalId(row.principal))) ||
        !Number.isSafeInteger(row.issuedAt) || (row.issuedAt as number) > at) throw Error("Invalid link");
    return { id: take(linkId(row as UnsignedRecord)), row };
  });
  if (new Set(links.map(link => link.id)).size !== links.length) throw Error("Duplicate link");
  const visiting = new Set<string>(), verified = new Map<string, readonly Rotate[]>();
  const contextFor = (principal: PrincipalId, now: number): ResolutionContext => {
    const account = accounts.get(principal);
    if (!account) throw Error("Missing account");
    const own = links.filter(link => link.row.principal === principal);
    const wallets = new Set(own.filter(link => link.row.kind === "wallet").map(link => link.row.address));
    const selected = links.filter(link => link.row.principal === principal || (link.row.kind === "wallet" && wallets.has(link.row.address)));
    const ids = new Set(selected.map(link => link.id));
    return { ...trust, now, links: new Map(selected.map(link => [link.id, link.row])),
      genesisEpubBindings: account.genesisEpubBindings,
      revocations: [...accounts.values()].flatMap(other => other.revocations.filter(raw =>
        other.principal === principal || ids.has(String(record(raw).linkId)))),
      history: (owner, issuedAt, until) => {
        const peer = accounts.get(owner), key = JSON.stringify([owner, until]);
        if (!peer || until > at || visiting.has(key)) return { ok: false, reason: "missing-history" };
        if (!verified.has(key)) {
          const prior = peer.rotations.filter(row => (record(row).issuedAt as number) <= until);
          visiting.add(key);
          try {
            const result = resolveCurrentKey(owner, prior, contextFor(owner, until));
            if (!result.ok || !result.value.bindingEpub || result.value.rotations.length !== prior.length)
              return { ok: false, reason: "missing-history" };
            verified.set(key, result.value.rotations);
          } finally { visiting.delete(key); }
        }
        return { ok: true, value: historyState(owner, verified.get(key)!, issuedAt, until) };
      } };
  };
  for (const [principal, account] of accounts) {
    const resolved = resolveCurrentKey(principal, account.rotations, contextFor(principal, at));
    if (!resolved.ok || resolved.diagnostics.length || !resolved.value.bindingEpub ||
        resolved.value.rotations.length !== account.rotations.length) throw Error("Invalid owner history");
  }
  return { accounts, contextFor };
}

export function createAclDelegationSource(config: AclStatementConfig, audience: string, suppliedTrust: DelegationTrust,
  fetcher: typeof fetch = fetch, clock = () => Math.floor(Date.now() / 1000)): AgentDelegationSource {
  const origin = new URL(audience);
  if (origin.protocol !== "https:" || origin.origin !== audience) throw Error("Invalid delegation audience");
  const trust = structuredClone(suppliedTrust);
  const source = createAclGraphSource(config, "delegations", fetcher, clock);
  return async (id, at) => {
    if (!/^[0-9a-f]{64}$/.test(id)) return null;
    const { snapshot } = await source.read(at, AbortSignal.timeout(1500));
    if (snapshot.audience !== audience) throw Error("Wrong delegation audience");
    const { accounts, contextFor } = contexts(snapshot.history, trust, at);
    const delegations = new Map<string, ReturnType<typeof parseAgentDelegation> extends Result<infer T> ? T : never>();
    const revocations: ReturnType<typeof parseAgentRevocation> extends Result<infer T> ? T[] : never = [];
    for (const raw of snapshot.rows) {
      const row = record(raw);
      if (Object.keys(row).sort().join() !== "kind,record") throw Error("Invalid delegation row");
      if (row.kind === "delegation") {
        const parsed = take(parseAgentDelegation(row.record));
        if (parsed.delegation.audience !== audience || delegations.has(parsed.id)) throw Error("Invalid delegation row");
        delegations.set(parsed.id, parsed);
      } else if (row.kind === "revocation") revocations.push(take(parseAgentRevocation(row.record)));
      else throw Error("Invalid delegation row");
    }
    const found = delegations.get(id);
    if (!found) return null;
    const owner = found.delegation.principal, account = accounts.get(owner);
    if (!account || clock() !== at) throw Error("Delegation history unavailable");
    return { completeThrough: at, delegation: found.delegation, rotations: account.rotations,
      context: contextFor(owner, at), revocations: revocations.filter(row => row.revocation.principal === owner).map(row => row.revocation) };
  };
}
