/**
 * Light SociACL Check — `CHECK(see, object, accessor)` at `now`.
 *
 * Reimplements the consume contract in `docs/s3rch-check.d.ts`.
 * Runs in the browser. Does not import FyberLabs/SociACL (crate, NAPI,
 * WASM, or npm). hopcap 1: do not walk friend edges. Hint never sets
 * `allowed`. Privilege-down (`cancelSee`) is immediate.
 */

import {
  fromGunNode,
  toGunNode,
  type GunFeedNode,
  type IdentitySeeGrant,
} from "@/lib/feed-types";

export { fromGunNode, toGunNode };
export type {
  FeedItem,
  FeedSource,
  GunFeedNode,
  GunUserNode,
  IdentityClaimKind,
  IdentitySeeGrant,
} from "@/lib/feed-types";

/** Locked Gun root. */
export type S3rchRoot = "s3rch";

export const S3RCH_ROOT = "s3rch" as const;
export const S3RCH_ITEMS = "items" as const;
export const S3RCH_USERS = "users" as const;
export const S3RCH_META = "meta" as const;

/**
 * Untrusted edge handoff (ingest / seeder / URL cross).
 * Decode does not verify. A hint never sets allowed.
 */
export type HandoffHint = {
  principal: string;
  target: string;
  verb?: string;
  context?: string;
};

/**
 * Permalink, RSS3 GI, RSS/Atom, or issuer HTTP.
 * Not a Gun node. Not a grant. A URL 200 is not see.
 */
export type UrlLeaf = {
  url: string;
};

/** Seed cache. gun.get('s3rch').get('meta'). Not a Check object. */
export type FeedMeta = {
  seededAt?: string;
  sourcesOk: number;
  sourcesTried: number;
  error?: string;
  count: number;
};

/** Feed item soul or claim id linked from the user node. */
export type CheckObjectId = string;

/** Wallet or s3rch/users/{wallet}. */
export type AccessorId = string;

export type CheckResult = {
  allowed: boolean;
  /** Predicate / deny reason. A present hint never makes this a grant. */
  reason: string;
};

/**
 * Live graph the browser reads. Only in-graph objects and jointly
 * stated see grants. Do not walk friend edges (hopcap 1).
 */
export type SeeGraph = {
  hasObject(object: CheckObjectId): boolean;
  ownerOf(object: CheckObjectId): AccessorId | undefined;
  seeGrants(object: CheckObjectId): readonly IdentitySeeGrant[];
};

/** Writable dest ACL. Cancel and admit land here, not on a URL. */
export type SeeAcl = SeeGraph & {
  putObject(object: CheckObjectId, owner: AccessorId): void;
  stateSeeGrant(owner: AccessorId, grant: IdentitySeeGrant): void;
  unstateSeeGrant(
    owner: AccessorId,
    accessor: AccessorId,
    object: CheckObjectId,
  ): void;
};

/** id.replace(/[.#$\[\]]/g, '_') */
export function encodeKey(id: string): string {
  return id.replace(/[.#$[\]]/g, "_");
}

/** s3rch/items/<encodeKey(id)> */
export function itemSoul(id: string): string {
  return `${S3RCH_ROOT}/${S3RCH_ITEMS}/${encodeKey(id)}`;
}

/** s3rch/users/<wallet> */
export function userSoul(wallet: string): string {
  return `${S3RCH_ROOT}/${S3RCH_USERS}/${wallet.trim()}`;
}

/** s3rch/meta — not a Check object. */
export function metaSoul(): string {
  return `${S3RCH_ROOT}/${S3RCH_META}`;
}

/** Does not verify. Does not mint. */
export function acceptHint(hint: HandoffHint): HandoffHint {
  return {
    principal: hint.principal,
    target: hint.target,
    ...(hint.verb !== undefined ? { verb: hint.verb } : {}),
    ...(hint.context !== undefined ? { context: hint.context } : {}),
  };
}

export function isUrlLeafId(id: string): boolean {
  return /^https?:\/\//i.test(id.trim());
}

export function isMetaId(id: string): boolean {
  const trimmed = id.trim();
  if (trimmed === metaSoul() || trimmed === S3RCH_META) return true;
  if (trimmed === `gun.get('${S3RCH_ROOT}').get('${S3RCH_META}')`) return true;
  if (trimmed === `gun.get("${S3RCH_ROOT}").get("${S3RCH_META}")`) return true;
  return false;
}

/**
 * Wallet as we name them → locked `s3rch/users/<wallet>`.
 * A soul path is left as-is. Not a second user node.
 */
export function accessorAliases(id: AccessorId): string[] {
  const trimmed = id.trim();
  if (!trimmed) return [];
  const aliases = new Set<string>([trimmed]);
  if (trimmed.startsWith(`${S3RCH_ROOT}/${S3RCH_USERS}/`)) {
    const wallet = trimmed.slice(`${S3RCH_ROOT}/${S3RCH_USERS}/`.length);
    if (wallet) {
      aliases.add(wallet);
      aliases.add(userSoul(wallet));
    }
    return [...aliases];
  }
  if (!trimmed.includes("/") && !trimmed.includes(".get(") && !isUrlLeafId(trimmed)) {
    aliases.add(userSoul(trimmed));
  }
  return [...aliases];
}

export function sameAccessor(
  left: AccessorId | undefined,
  right: AccessorId | undefined,
): boolean {
  if (!left || !right) return false;
  const rightAliases = new Set(accessorAliases(right));
  return accessorAliases(left).some((alias) => rightAliases.has(alias));
}

export function grantNamesObject(
  grant: IdentitySeeGrant,
  object: CheckObjectId,
): boolean {
  const claimId = grant.claimId.trim();
  if (!claimId) return false;
  if (claimId === object) return true;
  if (itemSoul(claimId) === object) return true;
  if (encodeKey(claimId) === object) return true;
  return false;
}

export function grantNamesAccessor(
  grant: IdentitySeeGrant,
  accessor: AccessorId,
): boolean {
  return sameAccessor(grant.accessor, accessor);
}

/** `now ∈ [from, until)` — `from` inclusive, `until` exclusive. */
export function grantLiveAt(grant: IdentitySeeGrant, now: number): boolean {
  return now >= grant.from && now < grant.until;
}

/**
 * CHECK(see, object, accessor) at now.
 * see maps to dest read. Hint is ignored for allowed.
 * Owner sees their object. Else a live IdentitySeeGrant must name
 * this pair and now ∈ [from, until). meta and UrlLeaf fail closed.
 */
export function checkSee(
  graph: SeeGraph,
  object: CheckObjectId,
  accessor: AccessorId,
  now: number,
  hint?: HandoffHint,
): CheckResult {
  void hint;
  if (isMetaId(object)) {
    return { allowed: false, reason: "meta" };
  }
  if (isUrlLeafId(object)) {
    return { allowed: false, reason: "url-leaf" };
  }
  if (!graph.hasObject(object)) {
    return { allowed: false, reason: "missing-object" };
  }
  if (sameAccessor(graph.ownerOf(object), accessor)) {
    return { allowed: true, reason: "owner" };
  }

  const named = graph
    .seeGrants(object)
    .filter((grant) => grantNamesObject(grant, object) && grantNamesAccessor(grant, accessor));
  const live = named.find((grant) => grantLiveAt(grant, now));
  if (live) {
    return { allowed: true, reason: "see-grant" };
  }
  if (named.length === 0) {
    return { allowed: false, reason: "missing-grant" };
  }
  if (named.every((grant) => now < grant.from)) {
    return { allowed: false, reason: "future-from" };
  }
  if (named.every((grant) => now >= grant.until)) {
    return { allowed: false, reason: "expired" };
  }
  return { allowed: false, reason: "denied" };
}

/**
 * Dest Check AND the presented grant window.
 * from denies until now is in range.
 */
export function checkSeeGrant(
  graph: SeeGraph,
  grant: IdentitySeeGrant,
  object: CheckObjectId,
  accessor: AccessorId,
  now: number,
  hint?: HandoffHint,
): CheckResult {
  const dest = checkSee(graph, object, accessor, now, hint);
  if (!grantNamesObject(grant, object) || !grantNamesAccessor(grant, accessor)) {
    return { allowed: false, reason: dest.reason === "owner" ? "denied" : dest.reason };
  }
  if (!grantLiveAt(grant, now)) {
    const reason = now < grant.from ? "future-from" : "expired";
    return { allowed: false, reason };
  }
  return dest;
}

function destOwner(owner: AccessorId): AccessorId | null {
  const trimmed = owner.trim();
  if (!trimmed) return null;
  if (isUrlLeafId(trimmed) || isMetaId(trimmed)) return null;
  return trimmed;
}

/**
 * Destination re-authorizes, then may put a GunFeedNode into items.
 * Hint / URL fetch is not authorization.
 */
export function admitFeedNode(
  acl: SeeAcl,
  node: GunFeedNode,
  owner: AccessorId,
  hint?: HandoffHint,
): { object: CheckObjectId } | { denied: true } {
  void hint;
  const dest = destOwner(owner);
  const item = fromGunNode(node);
  if (!dest || !item) {
    return { denied: true };
  }
  const object = itemSoul(item.id);
  if (isMetaId(object) || isUrlLeafId(object)) {
    return { denied: true };
  }
  acl.putObject(object, dest);
  return { object };
}

function resolveGrantObject(
  acl: SeeAcl,
  grant: IdentitySeeGrant,
): CheckObjectId | undefined {
  const claimId = grant.claimId.trim();
  if (!claimId || isUrlLeafId(claimId) || isMetaId(claimId)) return undefined;
  if (acl.hasObject(claimId)) return claimId;
  const soul = itemSoul(claimId);
  if (acl.hasObject(soul)) return soul;
  return undefined;
}

/** Jointly stated. hopcap 1. */
export function applySeeGrant(
  acl: SeeAcl,
  owner: AccessorId,
  grant: IdentitySeeGrant,
): void {
  const object = resolveGrantObject(acl, grant);
  if (!object) return;
  if (!sameAccessor(acl.ownerOf(object), owner)) return;
  if (isUrlLeafId(grant.accessor) || isMetaId(grant.accessor)) return;
  acl.stateSeeGrant(owner, grant);
}

/** Privilege-down is immediate. Dest ACL only. */
export function cancelSee(
  acl: SeeAcl,
  owner: AccessorId,
  accessor: AccessorId,
  object: CheckObjectId,
): void {
  acl.unstateSeeGrant(owner, accessor, object);
}
