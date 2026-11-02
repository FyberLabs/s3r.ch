import { seaToPrincipalKey } from "./forum-check";
import { parseForumRevoke, verifyForumRevokeNow, verifyForumRevokeWitness } from "./forum-revocation";
import type { ForumWitnessKey } from "./forum-witness-verification";

export type ForumRevocationTarget = Readonly<{ principal: string; linkId: string; issuedAt: number }>;
type Diagnostic = Readonly<{ index: number; reason: "bad-record" | "future-record" | "bad-proof" }>;
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0);

/** Apply supplied revocations to a previously authenticated recovery link.
 * The caller must authenticate the current signing key and historicalKeyAt
 * for this principal (the default assumes one key for the entire interval), and
 * supply the complete revocation list. `revoked: false` only describes that list;
 * it does not establish completeness, retention, key authority or eligibility.
 * Historical mode requires witnesses, evaluated at each revoke's issuance time.
 * Present mode additionally permits offline signatures under the current key.
 */
export async function checkForumLinkRevocations(
  target: ForumRevocationTarget, input: unknown, signingKey: string,
  trustedKeys: readonly ForumWitnessKey[], at: number, mode: "historical" | "present",
  historicalKeyAt: (issuedAt: number) => string | null = () => signingKey,
): Promise<Readonly<{ ok: false; reason: "bad-input" }> | Readonly<{ ok: true; revoked: boolean; diagnostics: readonly Diagnostic[] }>> {
  try {
    const { principal, linkId, issuedAt } = target;
    if (!integer(at) || !integer(issuedAt) || issuedAt > at || typeof principal !== "string" || !seaToPrincipalKey(principal) ||
      typeof signingKey !== "string" || !seaToPrincipalKey(signingKey) || typeof linkId !== "string" || !/^[0-9a-f]{64}$/.test(linkId) ||
      !["historical", "present"].includes(mode) || !Array.isArray(input)) return { ok: false, reason: "bad-input" };
    const d = Object.getOwnPropertyDescriptors(input) as unknown as Record<string, PropertyDescriptor>;
    const length: unknown = d.length.value;
    if (!integer(length) || length > 1024) return { ok: false, reason: "bad-input" };
    // Parse every entry before the first await so caller mutation cannot replace
    // a later revocation while an earlier witness is being checked.
    const rows = Array.from({ length }, (_, index) => parseForumRevoke(d[String(index)]?.value)?.record ?? null);
    // Snapshot witness metadata too; all downstream work uses this invocation's trust input.
    if (!Array.isArray(trustedKeys) || trustedKeys.length > 1024) return { ok: false, reason: "bad-input" };
    const keys = trustedKeys.map(k => ({ ...k, ...(k.key_ops ? { key_ops: [...k.key_ops] } : {}) }));
    const historicalKeys = rows.map(r => {
      if (!r || r.attest === undefined || r.issuedAt > at || r.principal !== principal || r.linkId !== linkId || r.issuedAt < issuedAt) return null;
      const key = historicalKeyAt(r.issuedAt);
      if (typeof key !== "string" || !seaToPrincipalKey(key)) throw Error("missing-history");
      return key;
    });
    const diagnostics: Diagnostic[] = [];
    let revoked = false;
    for (const [index, r] of rows.entries()) {
      if (!r) { diagnostics.push({ index, reason: "bad-record" }); continue; }
      if (r.issuedAt > at) { diagnostics.push({ index, reason: "future-record" }); continue; }
      if (r.principal !== principal || r.linkId !== linkId || r.issuedAt < issuedAt) continue;
      const historicalKey = historicalKeys[index];
      const witnessed = historicalKey === null ? null : await verifyForumRevokeWitness(r, historicalKey, keys, r.issuedAt);
      const verified = witnessed || (mode === "present" ? verifyForumRevokeNow(r, signingKey, at) : null);
      if (verified) revoked = true;
      else diagnostics.push({ index, reason: "bad-proof" });
    }
    return Object.freeze({ ok: true, revoked, diagnostics: Object.freeze(diagnostics.map(d => Object.freeze(d))) });
  } catch { return { ok: false, reason: "bad-input" }; }
}
