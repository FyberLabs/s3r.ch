/**
 * Lab dest ACL for light Check see-grants.
 *
 * In-memory graph with optional IndexedDB persistence. Grants are
 * `IdentitySeeGrant` records only. Do not write SIWE signatures, SEA
 * priv / epriv, wrap envelopes, or paper strings here — and never onto
 * public Gun.
 */

import type { IdentitySeeGrant } from "@/lib/feed-types";
import {
  grantNamesObject,
  sameAccessor,
  type AccessorId,
  type CheckObjectId,
  type SeeAcl,
} from "./check";

export const SEE_ACL_IDB_NAME = "s3rch-see-acl";
export const SEE_ACL_IDB_VERSION = 1;
export const SEE_ACL_STORE_NAME = "dest";
export const SEE_ACL_RECORD_KEY = "lab";

export type SeeAclSnapshot = {
  objects: Array<{ object: CheckObjectId; owner: AccessorId }>;
  grants: IdentitySeeGrant[];
};

export type MemorySeeAcl = SeeAcl & {
  snapshot(): SeeAclSnapshot;
  replace(snapshot: SeeAclSnapshot): void;
};

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

export function isIdentitySeeGrant(value: unknown): value is IdentitySeeGrant {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  for (const key of FORBIDDEN_SECRET_KEYS) {
    if (key in record) return false;
  }
  return (
    typeof record.claimId === "string" &&
    record.claimId.length > 0 &&
    typeof record.accessor === "string" &&
    record.accessor.length > 0 &&
    typeof record.from === "number" &&
    Number.isFinite(record.from) &&
    typeof record.until === "number" &&
    Number.isFinite(record.until)
  );
}

export function emptySeeAclSnapshot(): SeeAclSnapshot {
  return { objects: [], grants: [] };
}

export function sanitizeSeeAclSnapshot(value: unknown): SeeAclSnapshot {
  if (!value || typeof value !== "object") return emptySeeAclSnapshot();
  const record = value as Record<string, unknown>;
  for (const key of FORBIDDEN_SECRET_KEYS) {
    if (key in record) return emptySeeAclSnapshot();
  }
  const objects: SeeAclSnapshot["objects"] = [];
  if (Array.isArray(record.objects)) {
    for (const row of record.objects) {
      if (!row || typeof row !== "object") continue;
      const item = row as Record<string, unknown>;
      if (typeof item.object !== "string" || typeof item.owner !== "string") continue;
      if (!item.object || !item.owner) continue;
      objects.push({ object: item.object, owner: item.owner });
    }
  }
  const grants: IdentitySeeGrant[] = [];
  if (Array.isArray(record.grants)) {
    for (const grant of record.grants) {
      if (isIdentitySeeGrant(grant)) {
        grants.push({
          claimId: grant.claimId,
          accessor: grant.accessor,
          from: grant.from,
          until: grant.until,
        });
      }
    }
  }
  return { objects, grants };
}

function matchesGrantObject(grant: IdentitySeeGrant, object: CheckObjectId): boolean {
  return grantNamesObject(grant, object);
}

export function createMemorySeeAcl(seed: SeeAclSnapshot = emptySeeAclSnapshot()): MemorySeeAcl {
  const objects = new Map<CheckObjectId, AccessorId>();
  const grants: IdentitySeeGrant[] = [];

  const acl: MemorySeeAcl = {
    hasObject(object) {
      return objects.has(object);
    },
    ownerOf(object) {
      return objects.get(object);
    },
    seeGrants(object) {
      return grants.filter((grant) => matchesGrantObject(grant, object));
    },
    putObject(object, owner) {
      objects.set(object, owner);
    },
    stateSeeGrant(_owner, grant) {
      if (!isIdentitySeeGrant(grant)) return;
      const next: IdentitySeeGrant = {
        claimId: grant.claimId,
        accessor: grant.accessor,
        from: grant.from,
        until: grant.until,
      };
      const index = grants.findIndex(
        (existing) =>
          existing.claimId === next.claimId &&
          sameAccessor(existing.accessor, next.accessor) &&
          existing.from === next.from &&
          existing.until === next.until,
      );
      if (index >= 0) grants[index] = next;
      else grants.push(next);
    },
    unstateSeeGrant(_owner, accessor, object) {
      for (let i = grants.length - 1; i >= 0; i -= 1) {
        const grant = grants[i];
        if (!grant) continue;
        if (matchesGrantObject(grant, object) && sameAccessor(grant.accessor, accessor)) {
          grants.splice(i, 1);
        }
      }
    },
    snapshot() {
      return {
        objects: [...objects.entries()].map(([object, owner]) => ({ object, owner })),
        grants: grants.map((grant) => ({
          claimId: grant.claimId,
          accessor: grant.accessor,
          from: grant.from,
          until: grant.until,
        })),
      };
    },
    replace(snapshot) {
      objects.clear();
      grants.length = 0;
      const clean = sanitizeSeeAclSnapshot(snapshot);
      for (const row of clean.objects) {
        objects.set(row.object, row.owner);
      }
      grants.push(...clean.grants);
    },
  };

  acl.replace(sanitizeSeeAclSnapshot(seed));
  return acl;
}

function requireFactory(factory: IDBFactory | undefined): IDBFactory {
  if (!factory) {
    throw new Error("IndexedDB is not available in this runtime.");
  }
  return factory;
}

function openSeeAclDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(SEE_ACL_IDB_NAME, SEE_ACL_IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SEE_ACL_STORE_NAME)) {
        db.createObjectStore(SEE_ACL_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB open failed."));
  });
}

function idbRequest<T>(
  factory: IDBFactory | undefined,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const dbFactory = requireFactory(factory);
  return openSeeAclDb(dbFactory).then((db) => {
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(SEE_ACL_STORE_NAME, mode);
      const request = run(tx.objectStore(SEE_ACL_STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB request failed."));
      tx.oncomplete = () => db.close();
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error("IndexedDB transaction aborted."));
      };
    });
  });
}

export async function readSeeAclSnapshot(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<SeeAclSnapshot> {
  try {
    const raw = await idbRequest(factory, "readonly", (store) =>
      store.get(SEE_ACL_RECORD_KEY),
    );
    return sanitizeSeeAclSnapshot(raw);
  } catch {
    return emptySeeAclSnapshot();
  }
}

export async function writeSeeAclSnapshot(
  snapshot: SeeAclSnapshot,
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<void> {
  const clean = sanitizeSeeAclSnapshot(snapshot);
  await idbRequest(factory, "readwrite", (store) =>
    store.put(clean, SEE_ACL_RECORD_KEY),
  );
}

export async function hydrateSeeAcl(
  acl: MemorySeeAcl,
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<MemorySeeAcl> {
  const snapshot = await readSeeAclSnapshot(factory);
  acl.replace(snapshot);
  return acl;
}

export async function persistSeeAcl(
  acl: MemorySeeAcl,
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<void> {
  await writeSeeAclSnapshot(acl.snapshot(), factory);
}

export function grantsOwnedBy(
  acl: SeeAcl,
  owner: AccessorId,
): IdentitySeeGrant[] {
  const objects: CheckObjectId[] = [];
  if ("snapshot" in acl && typeof (acl as MemorySeeAcl).snapshot === "function") {
    for (const row of (acl as MemorySeeAcl).snapshot().objects) {
      if (sameAccessor(row.owner, owner)) objects.push(row.object);
    }
  }
  const seen = new Set<string>();
  const out: IdentitySeeGrant[] = [];
  for (const object of objects) {
    for (const grant of acl.seeGrants(object)) {
      const key = `${grant.claimId}|${grant.accessor}|${grant.from}|${grant.until}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(grant);
    }
  }
  return out;
}
