import { verifyForumRotationWitness } from "./forum-rotation-witness";
import type { ForumWitnessKey } from "./forum-witness-verification";

/** Direct recovery's witness/proof binding, separate from conflict evidence.
 * This does NOT validate SIWE wallet signatures, recovery-link eligibility,
 * retained links, or chain continuity. Legacy v2 and OIDC witnesses contain no
 * SIWE hash; those still require their respective recovery-authorizer checks.
 * Consumer copy of SociACL b7f9bc59 rotationClaimsMatch/siweProofHash.
 */
export async function verifyForumRotationProofBinding(
  input: unknown, trustedKeys: readonly ForumWitnessKey[], now: number,
): Promise<ReturnType<typeof verifyForumRotationWitness>> {
  const evidence = verifyForumRotationWitness(input, trustedKeys, now);
  if (!evidence || evidence.recoveryProof === "malformed") return null;
  const r = evidence.record;
  if (!Object.hasOwn(r, "nextEpub") || r.authorizer.kind !== "wallet") return evidence;
  // Hash the frozen snapshot already authenticated above, not mutable input.
  const fields = ["sociacl-siwe-proof-v1", r.authorizer.siwe.message, r.authorizer.siwe.signature]
    .map(s => new TextEncoder().encode(s));
  const bytes = new Uint8Array(fields.reduce((size, field) => size + 4 + field.length, 0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const field of fields) {
    view.setUint32(offset, field.length, true);
    offset += 4;
    bytes.set(field, offset);
    offset += field.length;
  }
  try {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
    return hex === evidence.witnessClaims.siweHash ? evidence : null;
  } catch { return null; }
}
