/** Feed object ACL paths with canonical SEA principal keys.
 * Minted canonical objects continue to use acl-souls.ts. */
import { seaToPrincipalKey } from "./forum-check";
import { encodeKey, S3RCH_ROOT, S3RCH_ACL, type AccessorId, type CheckObjectId } from "./check";

/**
 * Dest-ACL path key. encodeKey, then `/` → `_`, so a grant soul stays
 * five segments when the object id still contains slashes.
 */
export function legacyAclKey(id: string): string {
  return encodeKey(id).replace(/\//g, "_");
}

/**
 * Owner / accessor key on dest ACL. Only canonical SEA principal keys are
 * accepted; credential and user-object aliases cannot become principals.
 */
export function legacyAclPrincipalKey(id: string): string {
  const key = seaToPrincipalKey(id);
  if (!key) throw new Error("SEA principal required");
  return key;
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

