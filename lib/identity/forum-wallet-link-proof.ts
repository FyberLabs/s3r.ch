import { parseForumWalletLinkRecord, type UnverifiedForumWalletLink } from "./forum-wallet-link-record";
import { verifyForumKeySignature } from "./forum-key-signature";
import { verifyForumSiwe, type ForumSiwePolicy } from "./forum-siwe";
import { verifyForumWitness, type ForumWitnessKey } from "./forum-witness-verification";

/** Independent wallet signature and timestamp witness gate, before querying
 * an untrusted candidate's principal history. Does not verify the identity-key
 * signature or establish recovery eligibility. */
export async function verifyForumWalletLinkWitness(
  input: unknown, trustedKeys: readonly ForumWitnessKey[], policy: ForumSiwePolicy, at: number,
): Promise<Readonly<{ record: UnverifiedForumWalletLink; linkId: string }> | null> {
  try {
    if (!Number.isSafeInteger(at) || at < 0 || Object.is(at, -0)) return null;
    const parsed = parseForumWalletLinkRecord(input);
    if (!parsed || parsed.record.issuedAt > at) return null;
    const { record: r, bytes } = parsed;
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
    return Object.freeze({ record: r, linkId });
  } catch { return null; }
}

/** Full proof under a supplied historical signing key. The caller still must
 * authenticate that key and check retention/revocation before recovery use. */
export async function verifyForumWalletLinkProof(
  input: unknown, signingKey: string, trustedKeys: readonly ForumWitnessKey[],
  policy: ForumSiwePolicy, at: number,
): Promise<Readonly<{ record: UnverifiedForumWalletLink; linkId: string; signingKey: string }> | null> {
  const parsed = parseForumWalletLinkRecord(input);
  if (!parsed || !verifyForumKeySignature(signingKey, parsed.record.keySig, parsed.bytes)) return null;
  const witness = await verifyForumWalletLinkWitness(parsed.record, trustedKeys, policy, at);
  return witness ? Object.freeze({ ...witness, signingKey }) : null;
}
