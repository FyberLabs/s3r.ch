import { uniqueJson } from "./forum-witness-json";
import { verifyForumKeySignature } from "./forum-key-signature";

/** These keys and validity windows must come from independently trusted config,
 * never from a record, JWS header, or an untrusted peer's JWKS response. */
export type ForumWitnessKey = Readonly<{
  kid: string; kty: "EC"; crv: "P-256"; x: string; y: string;
  alg?: "ES256"; use?: "sig"; key_ops?: readonly "verify"[];
  notBefore: number; notAfter: number;
}>;
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0);
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function decode(part: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw Error("base64url");
  const raw = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  if (btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== part) throw Error("noncanonical");
  return uniqueJson(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(raw, c => c.charCodeAt(0))));
}
function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
/** Verifies only a witness JWS and its time bounds. Callers MUST bind exact
 * record-specific claims before using it as evidence. For historical evidence,
 * pass the historical evaluation time; this does not assert present freshness.
 * No key discovery, cache, or implicit trust in a token-supplied URL is allowed.
 */
export function verifyForumWitness(
  token: unknown, trustedKeys: readonly ForumWitnessKey[], at: number, skew = 0,
): Readonly<Record<string, unknown>> | null {
  try {
    if (typeof token !== "string" || token.length > 16384 || !integer(at) || !integer(skew) || skew > 300) return null;
    if (!Array.isArray(trustedKeys) || trustedKeys.length > 1024) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = decode(parts[0]), claims = decode(parts[1]);
    if (!object(header) || !object(claims) || header.alg !== "ES256" || typeof header.kid !== "string" || !header.kid ||
      Object.keys(header).some(k => !["alg", "kid", "typ"].includes(k)) || (header.typ !== undefined && header.typ !== "JWT")) return null;
    const matches = trustedKeys.filter(k => k.kid === header.kid);
    if (matches.length !== 1) return null;
    const k = matches[0];
    if (k.kty !== "EC" || k.crv !== "P-256" || typeof k.x !== "string" || typeof k.y !== "string" ||
      (k.alg !== undefined && k.alg !== "ES256") || (k.use !== undefined && k.use !== "sig") ||
      (k.key_ops !== undefined && (!Array.isArray(k.key_ops) || !k.key_ops.includes("verify") || k.key_ops.some((op: unknown) => op !== "verify")))) return null;
    if (!verifyForumKeySignature(k.x + "." + k.y, parts[2], new TextEncoder().encode(parts[0] + "." + parts[1]))) return null;
    const { iat, exp } = claims;
    if (!integer(iat) || !integer(exp) || exp <= iat || exp - iat > 900) return null;
    if (!integer(k.notBefore) || !integer(k.notAfter) || k.notBefore >= k.notAfter || iat < k.notBefore || iat >= k.notAfter) return null;
    // Subtraction avoids unsafe at + skew near MAX_SAFE_INTEGER.
    if (iat > at && iat - at > skew) return null;
    if (exp <= at && at - exp >= skew) return null;
    freeze(claims);
    return claims;
  } catch { return null; }
}
