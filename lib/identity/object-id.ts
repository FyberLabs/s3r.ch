/** Canonical object-ID validation shared by Check and ACL path construction.
 * Source contract and vectors are pinned in docs/sociacl-contract.json. */
import { seaFromPrincipalKey } from "./forum-check";

const RESERVED = new Set(["claim", "ext", "post", "member", "objset"]);
export function isCanonicalObjectId(object: unknown): boolean {
  if (typeof object !== "string") return false;
  if (/^(claim|ext)_[0-9a-f]{64}$/.test(object)) return true;
  const parts = /^([a-z][a-z0-9]{1,15})_(p_[0-9a-f]{128})_[0-9a-f]{32}$/.exec(object);
  return !!parts && !RESERVED.has(parts[1]) && seaFromPrincipalKey(parts[2]) !== null;
}

/** Transitional namespace discriminator, not validation. A malformed ID in a
 * canonical namespace must not fall back to wallet-era object matching. */
export function usesCanonicalObjectNamespace(object: unknown): boolean {
  return typeof object === "string" && /^(?:(?:claim|ext)_|[a-z][a-z0-9]*_p_)/i.test(object.trim());
}
