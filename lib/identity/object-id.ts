/** Canonical object-ID validation shared by Check and ACL path construction.
 * Source contract and vectors are pinned in docs/sociacl-contract.json. */
import { parseObjectId } from "sociacl-ids";

export function isCanonicalObjectId(object: unknown): boolean {
  return parseObjectId(object).ok;
}

/** Transitional namespace discriminator, not validation. A malformed ID in a
 * canonical namespace must not fall back to wallet-era object matching. */
export function usesCanonicalObjectNamespace(object: unknown): boolean {
  return typeof object === "string" && /^(?:(?:claim|ext)_|[a-z][a-z0-9]*_p_)/i.test(object.trim());
}
