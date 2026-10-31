import { p256 } from "@noble/curves/nist.js";
import { seaToPrincipalKey } from "./forum-check";

/** Cryptographic validity ONLY. Callers must independently resolve current-key
 * authority and validate issuance time before admitting an object or grant.
 * This accepts SociACL compact r||s signatures, not Gun's SEA JSON envelope.
 */
export function verifyForumKeySignature(key: unknown, signature: unknown, bytes: unknown): boolean {
  if (typeof key !== "string" || !seaToPrincipalKey(key)) return false;
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    if (!(bytes instanceof Uint8Array)) return false;
    const raw = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const canonical = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    if (raw.length !== 64 || canonical !== signature) return false;
    const [x, y] = key.split(".").map(part => Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)));
    return p256.verify(raw, bytes, new Uint8Array([4, ...x, ...y]), { prehash: true, lowS: false, format: "compact" });
  } catch {
    return false;
  }
}
