import { parseForumWalletLinkRecord } from "./forum-wallet-link-record";
import { verifyForumWalletLinkProof } from "./forum-wallet-link-proof";
import { createForumLinkKeyResolver, type AuthenticatedForumLinkHistory } from "./forum-link-retention";
import { parseForumRevoke } from "./forum-revocation";
import { checkForumLinkRevocations } from "./forum-link-revocations";
import type { ForumWitnessKey } from "./forum-witness-verification";
import type { ForumSiwePolicy } from "./forum-siwe";

/** Supplies one complete snapshot through `at`. History MUST already authenticate
 * transitions and reject forks/conflicts; revocations are raw evidence to verify.
 * Absence/unavailability is null, never an invented empty history/list.
 */
export type ForumRecoveryProvider = (principal: string, at: number) => Readonly<{
  history: AuthenticatedForumLinkHistory; revocations: readonly unknown[];
}> | null;

/** Eligibility at the supplied evaluation instant, not a durable capability.
 * Present mode permits current-key offline revokes; historical mode requires
 * timestamped revokes. Callers must not substitute present results for history.
 * A production authenticated/complete provider is still required for live use.
 */
export async function checkForumWalletLinkEligibility(
  input: unknown, provider: ForumRecoveryProvider | null, trustedKeys: readonly ForumWitnessKey[],
  policy: ForumSiwePolicy, at: number, mode: "historical" | "present",
) {
  const deny = (reason: "bad-input" | "missing-history" | "bad-proof" | "unretained-link" | "revoked-link") => Object.freeze({ ok: false as const, reason });
  try {
    const parsed = parseForumWalletLinkRecord(input);
    if (!parsed || !Number.isSafeInteger(at) || at < 0 || Object.is(at, -0) || parsed.record.issuedAt > at || !["present", "historical"].includes(mode)) return deny("bad-input");
    if (typeof provider !== "function") return deny("missing-history");
    const bundle = provider(parsed.record.principal, at);
    if (!bundle || !Array.isArray(bundle.revocations) || bundle.revocations.length > 1024) return deny("missing-history");
    const state = createForumLinkKeyResolver(() => bundle.history)(parsed.record.principal, parsed.record.issuedAt, at);
    if (!state) return deny("missing-history");
    const descriptors = Object.getOwnPropertyDescriptors(bundle.revocations) as unknown as Record<string, PropertyDescriptor>;
    const revocations = Array.from({ length: bundle.revocations.length }, (_, i) => parseForumRevoke(descriptors[String(i)]?.value)?.record ?? null);
    if (!Array.isArray(trustedKeys) || trustedKeys.length > 1024) return deny("bad-input");
    const keys = trustedKeys.map(k => ({ ...k, ...(k.key_ops ? { key_ops: [...k.key_ops] } : {}) }));
    // Authenticate the historical link at issuance; witness expiry today does
    // not erase its history. Eligibility now is constrained by retention/revokes.
    const proof = await verifyForumWalletLinkProof(parsed.record, state.keyAtIssuedAt, keys, policy, parsed.record.issuedAt);
    if (!proof) return deny("bad-proof");
    if (state.retainedLinks !== null && !state.retainedLinks.includes(proof.linkId)) return deny("unretained-link");
    const revocation = await checkForumLinkRevocations({ principal: proof.record.principal, linkId: proof.linkId, issuedAt: proof.record.issuedAt }, revocations, state.currentKey, keys, at, mode);
    if (!revocation.ok) return deny("missing-history");
    if (revocation.revoked) return deny("revoked-link");
    return Object.freeze({ ok: true as const, record: proof.record, linkId: proof.linkId, evaluatedAt: at, mode, diagnostics: revocation.diagnostics });
  } catch { return deny("missing-history"); }
}
