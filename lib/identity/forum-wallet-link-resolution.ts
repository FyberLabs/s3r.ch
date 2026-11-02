import { getAddress } from "viem";
import { parseForumWalletLinkRecord } from "./forum-wallet-link-record";
import { checkForumWalletLinkEligibility, type ForumRecoveryProvider } from "./forum-wallet-eligibility";
import type { ForumWitnessKey } from "./forum-witness-verification";
import type { ForumSiwePolicy } from "./forum-siwe";

type Diagnostic = Readonly<{ index: number; reason: string }>;
/** Resolve the newest eligible link for one exact wallet address. The provider
 * must supply complete authenticated histories and revocations; the caller must
 * supply the complete candidate-link set. This does not prove index completeness
 * or authorize a rotation by itself. Results are evaluation-time/mode bound.
 */
export async function resolveForumWalletRecoveryLink(
  address: string, input: unknown, provider: ForumRecoveryProvider | null,
  keys: readonly ForumWitnessKey[], policy: ForumSiwePolicy, at: number, mode: "historical" | "present",
) {
  const diagnostics: Diagnostic[] = [];
  const deny = (reason: "bad-input" | "missing-history" | "unknown-link" | "ambiguous-link") => Object.freeze({ ok: false as const, reason, diagnostics: Object.freeze(diagnostics.map(d => Object.freeze(d))) });
  try {
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address) || getAddress(address) !== address ||
      !Number.isSafeInteger(at) || at < 0 || Object.is(at, -0) || !["historical", "present"].includes(mode) || !Array.isArray(input)) return deny("bad-input");
    const descriptors = Object.getOwnPropertyDescriptors(input) as unknown as Record<string, PropertyDescriptor>;
    const length: unknown = descriptors.length.value;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 1024) return deny("bad-input");
    const rows = Array.from({ length }, (_, i) => parseForumWalletLinkRecord(descriptors[String(i)]?.value)?.record ?? null);
    // Start checks synchronously: each check snapshots its history, proof, policy
    // and revocations before its first await, isolating subsequent caller edits.
    const pending = rows.map((row, index) => {
      if (!row) { diagnostics.push({ index, reason: "bad-record" }); return null; }
      if (row.address !== address) return null;
      return checkForumWalletLinkEligibility(row, provider, keys, policy, at, mode);
    });
    const results = await Promise.all(pending);
    type Eligible = Extract<Awaited<ReturnType<typeof checkForumWalletLinkEligibility>>, { ok: true }>;
    const valid = new Map<string, Eligible>();
    let missing = false;
    for (const [index, result] of results.entries()) {
      if (!result) continue;
      if (!result.ok) {
        diagnostics.push({ index, reason: result.reason });
        if (result.reason === "missing-history") missing = true;
      } else valid.set(result.linkId, result);
    }
    diagnostics.sort((a,b) => a.index - b.index);
    if (missing) return deny("missing-history");
    const sorted = [...valid.values()].sort((a,b) => b.record.issuedAt - a.record.issuedAt || a.linkId.localeCompare(b.linkId));
    if (!sorted.length) return deny("unknown-link");
    if (sorted.length > 1 && sorted[0].record.issuedAt === sorted[1].record.issuedAt) return deny("ambiguous-link");
    return Object.freeze({ ok: true as const, link: sorted[0], diagnostics: Object.freeze(diagnostics.map(d => Object.freeze(d))) });
  } catch { return deny("bad-input"); }
}
