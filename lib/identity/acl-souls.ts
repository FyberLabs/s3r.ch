/** Canonical SociACL ACL paths. Invalid input returns null; no alias encoding.
 * Consumer contract: docs/s3rch-check.d.ts (source in sociacl-contract.json). */
import { seaToPrincipalKey, seaFromPrincipalKey } from "./forum-check";

const RESERVED = new Set(["claim", "ext", "post", "member", "objset"]);
function canonicalObject(object: string): boolean {
  if (typeof object !== "string") return false;
  if (/^(claim|ext)_[0-9a-f]{64}$/.test(object)) return true;
  const parts = /^([a-z][a-z0-9]{1,15})_(p_[0-9a-f]{128})_[0-9a-f]{32}$/.exec(object);
  return !!parts && !RESERVED.has(parts[1]) && seaFromPrincipalKey(parts[2]) !== null;
}

export function aclSoul(owner: string): string | null {
  const key = seaToPrincipalKey(owner);
  return key ? `s3rch/acl/${key}` : null;
}

export function grantSoul(owner: string, object: string, accessor: string): string | null {
  const root = aclSoul(owner), key = seaToPrincipalKey(accessor);
  return root && key && canonicalObject(object) ? `${root}/${object}/${key}` : null;
}
