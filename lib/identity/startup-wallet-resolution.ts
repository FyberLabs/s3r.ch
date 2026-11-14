import { getAddress } from "viem";
import { parseForumWalletLinkRecord } from "./forum-wallet-link-record";
import { resolveForumRecoveryHistory, type ForumRecoverySnapshot } from "./forum-recovery-history";
import { checkForumWalletLinkEligibility } from "./forum-wallet-eligibility";
import type { ForumWitnessKey } from "./forum-witness-verification";
import type { ForumSiwePolicy } from "./forum-siwe";

/** An independently authenticated source, NOT a browser/peer supplied snapshot.
 * read must return every candidate for this wallet and every relevant account's
 * history/revocations at the requested instant. It must return null if coverage
 * or freshness cannot be established. An owner-scoped ACL snapshot or local
 * IndexedDB link does not satisfy this contract. No such live source is assumed.
 */
export type StartupWalletSource = Readonly<{
  read(wallet: string, at: number, signal: AbortSignal): Promise<ForumRecoverySnapshot | null>;
}>;
export type StartupWalletTrust = Readonly<{
  keys: readonly ForumWitnessKey[]; policy: ForumSiwePolicy; pinnedIssuers: readonly string[];
}>;
export type StartupWalletResolution =
  | Readonly<{ ok: true; binding: Readonly<{ wallet: string; principal: string; sea_public_key: string; evaluated_at: number }> }>
  | Readonly<{ ok: false; reason: "bad-input" | "source-unavailable" | "invalid-evidence" | "missing-history" | "no-account" | "multiple-accounts" | "stale" }>;

/** Read-only staging primitive. The source is injected by trusted deployment
 * code, never selected by a request or evidence document. No publication,
 * enrollment, key access, caching, or newest-account selection occurs here.
 * Results are evaluation-time bindings, not login or provisioning capabilities.
 */
export function createStartupWalletResolver(source: StartupWalletSource | null, suppliedTrust: StartupWalletTrust,
  clock = () => Math.floor(Date.now() / 1000)) {
  const trust = structuredClone(suppliedTrust);
  return async (wallet: string, signal: AbortSignal = AbortSignal.timeout(5000)): Promise<StartupWalletResolution> => {
    const deny = (reason: Extract<StartupWalletResolution, { ok: false }>["reason"]): StartupWalletResolution => Object.freeze({ ok: false, reason });
    try {
      if (!/^0x[0-9a-fA-F]{40}$/.test(wallet) || getAddress(wallet) !== wallet) return deny("bad-input");
      const at = clock();
      if (!Number.isSafeInteger(at) || at < 0) return deny("bad-input");
      if (!source) return deny("source-unavailable");
      signal.throwIfAborted();
      // Bound even an unavailable source that fails to honor cancellation.
      const raw = await new Promise<ForumRecoverySnapshot | null>((resolve, reject) => {
        const abort = () => reject(Error("Source read cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        Promise.resolve().then(() => { signal.throwIfAborted(); return source.read(wallet, at, signal); })
          .then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      });
      signal.throwIfAborted();
      if (clock() !== at) return deny("stale");
      if (!raw) return deny("source-unavailable");
      const snapshot = structuredClone(raw);
      if (snapshot.completeThrough !== at) return deny("stale");
      if (!Array.isArray(snapshot.links) || snapshot.links.length > 1024 || !Array.isArray(snapshot.accounts) || snapshot.accounts.length > 64) return deny("invalid-evidence");
      const candidates = [];
      for (const rawLink of snapshot.links) {
        // OIDC records may be needed to authenticate a candidate's rotations.
        if (rawLink && typeof rawLink === "object" && "kind" in rawLink && rawLink.kind === "oidc") continue;
        const parsed = parseForumWalletLinkRecord(rawLink);
        if (!parsed) return deny("invalid-evidence");
        if (parsed.record.address === wallet) candidates.push(parsed.record);
      }
      const principals = new Set(candidates.map(row => row.principal));
      if (principals.size > 64) return deny("invalid-evidence");
      const accounts = new Map<string, string>();
      for (const principal of principals) {
        const history = await resolveForumRecoveryHistory(principal, snapshot, trust.keys, trust.policy, [...trust.pinnedIssuers], at);
        if (!history.ok) return deny("missing-history");
        for (const candidate of candidates.filter(row => row.principal === principal)) {
          const eligible = await checkForumWalletLinkEligibility(candidate, history.provider, trust.keys, trust.policy, at, "present");
          if (eligible.ok) accounts.set(principal, history.currentKey);
          else if (eligible.reason !== "revoked-link" && eligible.reason !== "unretained-link") return deny(eligible.reason === "missing-history" ? "missing-history" : "invalid-evidence");
        }
      }
      signal.throwIfAborted();
      if (clock() !== at) return deny("stale");
      if (accounts.size === 0) return deny("no-account");
      if (accounts.size !== 1) return deny("multiple-accounts");
      const [principal, sea_public_key] = [...accounts][0];
      return Object.freeze({ ok: true, binding: Object.freeze({ wallet, principal, sea_public_key, evaluated_at: at }) });
    } catch { return deny("source-unavailable"); }
  };
}
