import { parsePrincipalId, verifyKeySignature } from "sociacl-ids";

/** Cryptographic validity only. Current-key authority and issuance time are
 * independently checked by callers. SociACL owns compact r||s validation;
 * this adapter preserves the application's boolean boundary.
 */
export function verifyForumKeySignature(key: unknown, signature: unknown, bytes: unknown): boolean {
  try {
    if (typeof signature !== "string" || !(bytes instanceof Uint8Array)) return false;
    const principal = parsePrincipalId(key);
    return principal.ok && verifyKeySignature(principal.value, signature, bytes).ok;
  } catch {
    return false;
  }
}
