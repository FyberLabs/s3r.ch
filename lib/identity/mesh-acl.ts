/**
 * Mesh dest ACL on Gun: MeshSeeGrant under s3rch/acl.
 *
 * Lab IndexedDB dest ACL stays the immediate privilege-down store.
 * These helpers put / read / HAM-merge the same grant on the Gun path
 * so peers can evaluate checkSee when the seed / WebRTC graph has the
 * ACL row. Grant ≠ share ≠ delivery ≠ unshare.
 *
 * Cancel is owner-only and must bump hamState so privilege-down wins
 * the next merge. Do not cache an allow.
 */

import type { IdentitySeeGrant } from "@/lib/feed-types";
import {
  aclKey,
  aclPrincipalKey,
  applySeeGrant,
  cancelSee,
  grantSoul,
  isAclId,
  isMetaId,
  isUrlLeafId,
  ownerOwnsObject,
  sameAccessor,
  S3RCH_ACL,
  S3RCH_ROOT,
  type AccessorId,
  type CheckObjectId,
  type GunAclEdge,
  type MeshSeeGrant,
  type SeeAcl,
} from "./check";
import { isIdentitySeeGrant } from "./see-acl";

const FORBIDDEN_SECRET_KEYS = [
  "priv",
  "epriv",
  "seaPair",
  "wrap",
  "paper",
  "signature",
  "walletSignature",
  "siwe",
  "dek",
  "kek",
] as const;

export type MeshAclGunRef = {
  get: (key: string) => MeshAclGunRef;
  put: (data: unknown) => MeshAclGunRef;
  map?: () => {
    on: (cb: (data: unknown, key: string) => void) => { off?: () => void };
  };
};

export type MeshAclIndex = {
  get(soul: string): GunAclEdge | undefined;
  merge(edge: GunAclEdge): GunAclEdge;
  snapshot(): GunAclEdge[];
};

function hasForbiddenSecrets(value: object): boolean {
  return FORBIDDEN_SECRET_KEYS.some((key) => key in value);
}

export function isMeshSeeGrant(value: unknown): value is MeshSeeGrant {
  if (!value || typeof value !== "object") return false;
  if (hasForbiddenSecrets(value)) return false;
  const record = value as Record<string, unknown>;
  const stated = record.stated;
  return (
    typeof record.object === "string" &&
    record.object.length > 0 &&
    typeof record.accessor === "string" &&
    record.accessor.length > 0 &&
    typeof record.from === "number" &&
    Number.isFinite(record.from) &&
    typeof record.until === "number" &&
    Number.isFinite(record.until) &&
    (stated === 0 || stated === 1)
  );
}

/** Higher hamState wins. Cancel must bump so it wins the next merge. */
export function nextHamState(previous?: number, now = Date.now()): number {
  const base = typeof previous === "number" && Number.isFinite(previous) ? previous : 0;
  return Math.max(base + 1, now);
}

export function mergeGunAclEdge(
  existing: GunAclEdge | undefined,
  incoming: GunAclEdge,
): GunAclEdge {
  if (!existing) return incoming;
  if (incoming.hamState > existing.hamState) return incoming;
  return existing;
}

export function toMeshSeeGrant(
  grant: IdentitySeeGrant,
  stated: 0 | 1,
): MeshSeeGrant {
  return {
    object: grant.claimId,
    accessor: grant.accessor,
    from: grant.from,
    until: grant.until,
    stated,
  };
}

export function meshSeeGrantToIdentity(grant: MeshSeeGrant): IdentitySeeGrant {
  return {
    claimId: grant.object,
    accessor: grant.accessor,
    from: grant.from,
    until: grant.until,
  };
}

export function createMeshAclIndex(seed: GunAclEdge[] = []): MeshAclIndex {
  const edges = new Map<string, GunAclEdge>();
  for (const edge of seed) {
    edges.set(edge.soul, mergeGunAclEdge(edges.get(edge.soul), edge));
  }
  return {
    get(soul) {
      return edges.get(soul);
    },
    merge(edge) {
      const won = mergeGunAclEdge(edges.get(edge.soul), edge);
      edges.set(edge.soul, won);
      return won;
    },
    snapshot() {
      return [...edges.values()];
    },
  };
}

export function prepareMeshSeeGrant(
  owner: AccessorId,
  grant: IdentitySeeGrant,
  previousHam?: number,
  now = Date.now(),
): GunAclEdge | null {
  if (!isIdentitySeeGrant(grant)) return null;
  if (isUrlLeafId(grant.claimId) || isMetaId(grant.claimId) || isAclId(grant.claimId)) {
    return null;
  }
  if (isUrlLeafId(grant.accessor) || isMetaId(grant.accessor) || isAclId(grant.accessor)) {
    return null;
  }
  const dest = owner.trim();
  if (!dest || isUrlLeafId(dest) || isMetaId(dest) || isAclId(dest)) return null;
  const mesh = toMeshSeeGrant(grant, 1);
  return {
    soul: grantSoul(dest, mesh.object, mesh.accessor),
    owner: dest,
    grant: mesh,
    hamState: nextHamState(previousHam, now),
  };
}

export function prepareMeshSeeCancel(
  owner: AccessorId,
  accessor: AccessorId,
  object: CheckObjectId,
  previousHam?: number,
  now = Date.now(),
): GunAclEdge | null {
  const dest = owner.trim();
  const who = accessor.trim();
  const target = object.trim();
  if (!dest || !who || !target) return null;
  if (isUrlLeafId(target) || isMetaId(target) || isAclId(target)) return null;
  if (isUrlLeafId(who) || isMetaId(who) || isAclId(who)) return null;
  if (isUrlLeafId(dest) || isMetaId(dest) || isAclId(dest)) return null;
  const mesh: MeshSeeGrant = {
    object: target,
    accessor: who,
    from: 0,
    until: 0,
    stated: 0,
  };
  return {
    soul: grantSoul(dest, target, who),
    owner: dest,
    grant: mesh,
    hamState: nextHamState(previousHam, now),
  };
}

export function gunAclWireNode(edge: GunAclEdge): Record<string, unknown> {
  return {
    object: edge.grant.object,
    accessor: edge.grant.accessor,
    from: edge.grant.from,
    until: edge.grant.until,
    stated: edge.grant.stated,
    owner: edge.owner,
    hamState: edge.hamState,
  };
}

export function fromGunAclNode(
  value: unknown,
  ownerKey?: string,
  objectKey?: string,
  accessorKey?: string,
): GunAclEdge | null {
  if (!value || typeof value !== "object") return null;
  if (hasForbiddenSecrets(value)) return null;
  const record = value as Record<string, unknown>;
  const hamState = record.hamState;
  const recordedOwner = record.owner;
  if (!isMeshSeeGrant(record)) return null;
  const grant: MeshSeeGrant = {
    object: record.object,
    accessor: record.accessor,
    from: record.from,
    until: record.until,
    stated: record.stated,
  };
  if (typeof hamState !== "number" || !Number.isFinite(hamState)) {
    return null;
  }
  const owner =
    typeof recordedOwner === "string" && recordedOwner.trim()
      ? recordedOwner.trim()
      : ownerKey?.trim();
  if (!owner) return null;
  if (ownerKey && aclPrincipalKey(owner) !== aclPrincipalKey(ownerKey)) {
    return null;
  }
  if (objectKey && aclKey(grant.object) !== objectKey) return null;
  if (accessorKey && aclPrincipalKey(grant.accessor) !== aclPrincipalKey(accessorKey)) {
    return null;
  }
  return {
    soul: grantSoul(owner, grant.object, grant.accessor),
    owner,
    grant,
    hamState,
  };
}

/** Register the named object on dest ACL, then apply or cancel. */
export function applyGunAclEdge(acl: SeeAcl, edge: GunAclEdge): void {
  const { owner, grant } = edge;
  if (isUrlLeafId(grant.object) || isMetaId(grant.object) || isAclId(grant.object)) {
    return;
  }
  acl.putObject(grant.object, owner);
  if (grant.stated === 1) {
    applySeeGrant(acl, owner, meshSeeGrantToIdentity(grant));
    return;
  }
  cancelSee(acl, owner, grant.accessor, grant.object);
}

export function ingestGunAclEdge(
  acl: SeeAcl,
  mesh: MeshAclIndex,
  value: unknown,
  ownerKey?: string,
  objectKey?: string,
  accessorKey?: string,
): GunAclEdge | null {
  const incoming = fromGunAclNode(value, ownerKey, objectKey, accessorKey);
  if (!incoming) return null;
  const won = mesh.merge(incoming);
  if (won.hamState !== incoming.hamState) return won;
  applyGunAclEdge(acl, won);
  return won;
}

export function putMeshSeeGrant(gun: MeshAclGunRef, edge: GunAclEdge): void {
  gun
    .get(S3RCH_ROOT)
    .get(S3RCH_ACL)
    .get(aclPrincipalKey(edge.owner))
    .get(aclKey(edge.grant.object))
    .get(aclPrincipalKey(edge.grant.accessor))
    .put(gunAclWireNode(edge));
}

export function meshAclRef(gun: MeshAclGunRef): MeshAclGunRef {
  return gun.get(S3RCH_ROOT).get(S3RCH_ACL);
}

/**
 * Local dest ACL first (privilege-down / grant is immediate here),
 * then put MeshSeeGrant on Gun so peers can HAM-merge.
 */
export function stateSeeGrantOnMesh(
  acl: SeeAcl,
  mesh: MeshAclIndex,
  owner: AccessorId,
  grant: IdentitySeeGrant,
  gun?: MeshAclGunRef | null,
): GunAclEdge | null {
  applySeeGrant(acl, owner, grant);
  if (!sameAccessor(acl.ownerOf(grant.claimId), owner)) {
    const aliases = [grant.claimId];
    if (!aliases.some((object) => sameAccessor(acl.ownerOf(object), owner))) {
      return null;
    }
  }
  const soul = grantSoul(owner, grant.claimId, grant.accessor);
  const edge = prepareMeshSeeGrant(owner, grant, mesh.get(soul)?.hamState);
  if (!edge) return null;
  mesh.merge(edge);
  if (gun) putMeshSeeGrant(gun, edge);
  return edge;
}

/**
 * Local cancel first (immediate), then put stated:0 with a bumped
 * hamState so the next peer merge denies.
 */
export function cancelSeeOnMesh(
  acl: SeeAcl,
  mesh: MeshAclIndex,
  owner: AccessorId,
  accessor: AccessorId,
  object: CheckObjectId,
  gun?: MeshAclGunRef | null,
): GunAclEdge | null {
  if (!ownerOwnsObject(acl, owner, object)) return null;
  cancelSee(acl, owner, accessor, object);
  const soul = grantSoul(owner, object, accessor);
  const edge = prepareMeshSeeCancel(owner, accessor, object, mesh.get(soul)?.hamState);
  if (!edge) return null;
  mesh.merge(edge);
  if (gun) putMeshSeeGrant(gun, edge);
  return edge;
}

export function subscribeMeshAcl(
  gun: MeshAclGunRef,
  onEdge: (edge: GunAclEdge, keys: { owner: string; object: string; accessor: string }) => void,
): () => void {
  const root = meshAclRef(gun);
  const offs: Array<() => void> = [];
  const ownerMap = root.map?.();
  if (!ownerMap) return () => {};
  const ownerListen = ownerMap.on((_ownerNode, ownerKey) => {
    if (!ownerKey) return;
    const objectMap = root.get(ownerKey).map?.();
    if (!objectMap) return;
    const objectListen = objectMap.on((_objectNode, objectKey) => {
      if (!objectKey) return;
      const accessorMap = root.get(ownerKey).get(objectKey).map?.();
      if (!accessorMap) return;
      const accessorListen = accessorMap.on((data, accessorKey) => {
        const edge = fromGunAclNode(data, ownerKey, objectKey, accessorKey);
        if (!edge) return;
        onEdge(edge, { owner: ownerKey, object: objectKey, accessor: accessorKey });
      });
      if (typeof accessorListen?.off === "function") {
        offs.push(() => accessorListen.off?.());
      }
    });
    if (typeof objectListen?.off === "function") {
      offs.push(() => objectListen.off?.());
    }
  });
  if (typeof ownerListen?.off === "function") {
    offs.push(() => ownerListen.off?.());
  }
  return () => {
    for (const off of offs) off();
  };
}
