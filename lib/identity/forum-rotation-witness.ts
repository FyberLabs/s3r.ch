import { parseForumRotationCandidate, type UnverifiedForumRotation } from "./forum-rotation-record";
import { verifyForumKeySignature } from "./forum-key-signature";
import { verifyForumWitness, type ForumWitnessKey } from "./forum-witness-verification";

/** Authenticate transition evidence for subsequent conflict/history processing.
 * This does NOT authorize rotation: recovery-link eligibility, SIWE/OIDC proof,
 * sequence/previous-key continuity, retained links and forks still require checks.
 * A malformed SIWE copy deliberately remains available as conflict evidence.
 * Mirrors SociACL b7f9bc59 authenticatedSibling/rotationTransitionClaimsMatch.
 */
export function verifyForumRotationWitness(
  input: unknown, trustedKeys: readonly ForumWitnessKey[], now: number,
): Readonly<{
  record: UnverifiedForumRotation;
  recoveryProof: "unverified" | "malformed";
  witnessClaims: Readonly<Record<string, unknown>>;
}> | null {
  if (!Number.isSafeInteger(now) || now < 0 || Object.is(now, -0)) return null;
  const candidate = parseForumRotationCandidate(input);
  if (!candidate || candidate.record.issuedAt > now) return null;
  const { record: r, bytes, recoveryProof } = candidate;
  if (!verifyForumKeySignature(r.nextKey, r.nextSig, bytes)) return null;
  // Historical witness verification: expiry today does not erase an event that
  // was witnessed at issuance. Trusted key authorization still bounds issuance.
  const c = verifyForumWitness(r.attest, trustedKeys, r.issuedAt);
  if (!c) return null;
  const epub = Object.hasOwn(r, "nextEpub");
  const wallet = epub && r.authorizer.kind === "wallet";
  const allowed = ["typ", "principal", "nextKey", "seq", "iat", "exp", "auth", "linkId", "retainedLinks"];
  if (epub) allowed.push("nextEpub");
  if (wallet) allowed.push("siweHash");
  const typ = !epub ? "sociacl-rotate-attest-v2" : wallet ? "sociacl-rotate-attest-v4" : "sociacl-rotate-attest-v3";
  if (Object.keys(c).some(k => !allowed.includes(k)) || c.typ !== typ || c.principal !== r.principal ||
    c.nextKey !== r.nextKey || (epub && c.nextEpub !== r.nextEpub) || c.seq !== r.seq || c.iat !== r.issuedAt ||
    c.auth !== r.authorizer.kind || c.linkId !== r.authorizer.link ||
    !Array.isArray(c.retainedLinks) || c.retainedLinks.length !== r.retainedLinks.length ||
    c.retainedLinks.some((id, i) => id !== r.retainedLinks[i])) return null;
  // This authenticates the witness's proof commitment, not the presented proof.
  // Direct recovery verification must additionally compare its SIWE proof hash.
  if (wallet && (typeof c.siweHash !== "string" || !/^[0-9a-f]{64}$/.test(c.siweHash))) return null;
  return Object.freeze({ record: r, recoveryProof, witnessClaims: c });
}
