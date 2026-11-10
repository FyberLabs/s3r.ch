/** Wallet-era feed ACL paths. Canonical callers must use acl-souls.ts.
 * Retained only for the existing feed consumer pending #277/#281 migration. */
import { getAddress } from "viem";
import { encodeKey, S3RCH_ROOT, S3RCH_ACL, S3RCH_USERS, type AccessorId, type CheckObjectId } from "./check";

/**
 * Dest-ACL path key. encodeKey, then `/` → `_`, so a grant soul stays
 * five segments when the object id still contains slashes.
 */
export function legacyAclKey(id: string): string {
  return encodeKey(id).replace(/\//g, "_");
}

/**
 * Owner / accessor key on dest ACL. `s3rch/users/<wallet>` collapses
 * to the wallet. Anything else is legacyAclKey.
 */
export function legacyAclPrincipalKey(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return "";
  let key = trimmed;
  if (trimmed.startsWith(`${S3RCH_ROOT}/${S3RCH_USERS}/`)) {
    key = trimmed.slice(`${S3RCH_ROOT}/${S3RCH_USERS}/`.length);
  }
  try {
    return getAddress(key);
  } catch {
    return legacyAclKey(key);
  }
}

/**
 * Owner dest-ACL root. Not a Check object.
 * gun.get('s3rch').get('acl').get(legacyAclPrincipalKey(owner))
 */
export function legacyAclSoul(owner: AccessorId): string {
  return `${S3RCH_ROOT}/${S3RCH_ACL}/${legacyAclPrincipalKey(owner)}`;
}

/**
 * Jointly stated see grant under the object owner's dest ACL.
 * gun.get('s3rch').get('acl')
 *   .get(legacyAclPrincipalKey(owner))
 *   .get(legacyAclKey(object))
 *   .get(legacyAclPrincipalKey(accessor))
 */
export function legacyGrantSoul(
  owner: AccessorId,
  object: CheckObjectId,
  accessor: AccessorId,
): string {
  return `${legacyAclSoul(owner)}/${legacyAclKey(object)}/${legacyAclPrincipalKey(accessor)}`;
}

