/** Canonical SociACL ACL paths. Invalid input returns null; no alias encoding.
 * Consumer contract: docs/s3rch-check.d.ts (source in sociacl-contract.json). */
import { seaToPrincipalKey } from "./forum-check";
import { isCanonicalObjectId } from "./object-id";

export function aclSoul(owner: string): string | null {
  const key = seaToPrincipalKey(owner);
  return key ? `s3rch/acl/${key}` : null;
}

export function grantSoul(owner: string, object: string, accessor: string): string | null {
  const root = aclSoul(owner), key = seaToPrincipalKey(accessor);
  return root && key && isCanonicalObjectId(object) ? `${root}/${object}/${key}` : null;
}
