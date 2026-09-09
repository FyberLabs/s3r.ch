/**
 * Private held-confirm proofs. Origin IndexedDB / memory only.
 * Claim id may later be shared onto GunUserNode.indicators.
 * The proof itself never goes on Gun.
 */

import { getAddress } from "viem";
import {
  claimFamilyOf,
  lookupValueFromClaimId,
  type HeldLookupState,
} from "./held-claims";

export const CONFIRM_PROOF_IDB_NAME = "s3rch-held-confirm";
export const CONFIRM_PROOF_IDB_VERSION = 1;
export const CONFIRM_PROOF_STORE_NAME = "proofs";

export type HeldConfirmKind = "email" | "phone" | "kyc";
export type HeldConfirmMethod = "fixture" | "otp" | "issuer";

export type HeldConfirmProof = {
  address: string;
  claimId: string;
  kind: HeldConfirmKind;
  method: HeldConfirmMethod;
  confirmedAt: number;
  v: 1;
};

export type ConfirmProofStore = {
  list(address: string): Promise<HeldConfirmProof[]>;
  put(proof: HeldConfirmProof): Promise<void>;
};

const FORBIDDEN_SECRET_KEYS = [
  "priv",
  "epriv",
  "signature",
  "siwe",
  "seaPair",
  "wrap",
  "paper",
  "dek",
  "kek",
  "walletSignature",
  "code",
  "otp",
] as const;

export function confirmProofHasForbiddenSecrets(value: object): boolean {
  return FORBIDDEN_SECRET_KEYS.some((key) => key in value);
}

export function isHeldConfirmProof(value: unknown): value is HeldConfirmProof {
  if (!value || typeof value !== "object") return false;
  if (confirmProofHasForbiddenSecrets(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.address !== "string") return false;
  try {
    if (getAddress(row.address) !== row.address) return false;
  } catch {
    return false;
  }
  if (typeof row.claimId !== "string" || !row.claimId.trim()) return false;
  if (row.claimId.includes("/claims/")) return false;
  if (row.kind !== "email" && row.kind !== "phone" && row.kind !== "kyc") {
    return false;
  }
  if (row.method !== "fixture" && row.method !== "otp" && row.method !== "issuer") {
    return false;
  }
  if (typeof row.confirmedAt !== "number" || !Number.isFinite(row.confirmedAt)) {
    return false;
  }
  if (row.v !== 1) return false;
  const family = claimFamilyOf(row.claimId);
  if (family !== row.kind) return false;
  return true;
}

export function lookupsFromConfirmProofs(
  proofs: readonly HeldConfirmProof[],
): Pick<HeldLookupState, "email" | "phone" | "kyc"> {
  const lookups: Pick<HeldLookupState, "email" | "phone" | "kyc"> = {};
  for (const proof of proofs) {
    lookups[proof.kind] = lookupValueFromClaimId(proof.claimId);
  }
  return lookups;
}

export function createMemoryConfirmProofStore(
  seed: Iterable<HeldConfirmProof> = [],
): ConfirmProofStore {
  const byAddress = new Map<string, Map<string, HeldConfirmProof>>();
  for (const proof of seed) {
    if (!isHeldConfirmProof(proof)) continue;
    const bucket = byAddress.get(proof.address) ?? new Map();
    bucket.set(proof.kind, proof);
    byAddress.set(proof.address, bucket);
  }
  return {
    async list(address) {
      let checksum: string;
      try {
        checksum = getAddress(address);
      } catch {
        return [];
      }
      return [...(byAddress.get(checksum)?.values() ?? [])];
    },
    async put(proof) {
      if (!isHeldConfirmProof(proof)) {
        throw new Error("Invalid held-confirm proof.");
      }
      const bucket = byAddress.get(proof.address) ?? new Map();
      bucket.set(proof.kind, proof);
      byAddress.set(proof.address, bucket);
    },
  };
}

export function createIndexedDbConfirmProofStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): ConfirmProofStore {
  return {
    async list(address) {
      let checksum: string;
      try {
        checksum = getAddress(address);
      } catch {
        return [];
      }
      try {
        const raw = await idbRequest(factory, "readonly", (store) =>
          store.getAll(IDBKeyRange.bound(`${checksum}\0`, `${checksum}\uFFFF`)),
        );
        return (Array.isArray(raw) ? raw : [])
          .map((row) => (isHeldConfirmProof(row) ? row : null))
          .filter((row): row is HeldConfirmProof => Boolean(row))
          .filter((row) => row.address === checksum);
      } catch {
        return [];
      }
    },
    async put(proof) {
      if (!isHeldConfirmProof(proof)) {
        throw new Error("Invalid held-confirm proof.");
      }
      await idbRequest(factory, "readwrite", (store) => store.put(toRecord(proof)));
    },
  };
}

type ProofRecord = HeldConfirmProof & { key: string };

function toRecord(proof: HeldConfirmProof): ProofRecord {
  return { ...proof, key: `${proof.address}\0${proof.kind}` };
}

let defaultStore: ConfirmProofStore | null = null;

export function defaultConfirmProofStore(): ConfirmProofStore {
  if (!defaultStore) {
    defaultStore = createIndexedDbConfirmProofStore();
  }
  return defaultStore;
}

export function listHeldConfirmProofs(
  address: string,
  store: ConfirmProofStore = defaultConfirmProofStore(),
): Promise<HeldConfirmProof[]> {
  return store.list(address);
}

export function putHeldConfirmProof(
  proof: HeldConfirmProof,
  store: ConfirmProofStore = defaultConfirmProofStore(),
): Promise<void> {
  return store.put(proof);
}

function requireFactory(factory: IDBFactory | undefined): IDBFactory {
  if (!factory) {
    throw new Error("IndexedDB is not available in this runtime.");
  }
  return factory;
}

function openConfirmProofDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(CONFIRM_PROOF_IDB_NAME, CONFIRM_PROOF_IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CONFIRM_PROOF_STORE_NAME)) {
        db.createObjectStore(CONFIRM_PROOF_STORE_NAME, { keyPath: "key" });
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
  return openConfirmProofDb(dbFactory).then((db) => {
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(CONFIRM_PROOF_STORE_NAME, mode);
      const request = run(tx.objectStore(CONFIRM_PROOF_STORE_NAME));
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
