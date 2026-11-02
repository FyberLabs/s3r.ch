import { parseForumWalletLinkRecord, type UnverifiedForumWalletLink } from "./forum-wallet-link-record";
import { verifyForumKeySignature } from "./forum-key-signature";
import { verifyForumSiwe, type ForumSiwePolicy } from "./forum-siwe";
import { verifyForumWitness, type ForumWitnessKey } from "./forum-witness-verification";

/** Verify the proof bundle under a supplied historical signing key.
 * The caller must independently authenticate that key for this principal and
 * issuance time, and check retained-link membership and revocation at use time.
 * Success is cryptographic evidence, NOT current recovery eligibility.
 * `at` is explicit: historical proofs must be evaluated at the historical event.
 */
export async function verifyForumWalletLinkProof(
  input: unknown, signingKey: string, trustedKeys: readonly ForumWitnessKey[],
  policy: ForumSiwePolicy, at: number,
): Promise<Readonly<{ record: UnverifiedForumWalletLink; linkId: string; signingKey: string }> | null> {
  try {
    if (!Number.isSafeInteger(at) || at < 0 || Object.is(at, -0)) return null;
    const parsed = parseForumWalletLinkRecord(input);
    if (!parsed || parsed.record.issuedAt > at) return null;
    const { record: r, bytes } = parsed;
    if (!verifyForumKeySignature(signingKey, r.keySig, bytes)) return null;
    // Resolve trusted witness config synchronously before any await. The claims
    // and record are frozen snapshots; later caller mutation cannot replace them.
    const claims = verifyForumWitness(r.attest, trustedKeys, at);
    if (!claims || Object.keys(claims).some(k => !["typ", "principal", "linkId", "iat", "exp"].includes(k)) ||
      claims.typ !== "sociacl-wallet-attest-v1" || claims.principal !== r.principal || claims.iat !== r.issuedAt) return null;
    // verifyForumSiwe snapshots policy and bytes synchronously on invocation.
    const walletCheck = verifyForumSiwe(r.address, r.siwe.message, r.siwe.signature, bytes, r.issuedAt, at, policy, r.nonce);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
    const linkId = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
    if (!await walletCheck || claims.linkId !== linkId) return null;
    return Object.freeze({ record: r, linkId, signingKey });
  } catch { return null; }
}
