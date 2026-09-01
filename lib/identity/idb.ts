import { getAddress } from "viem";
import { isSeaPair, type SeaPair } from "./sea";
import { isPrfWrapEnvelope, type PrfWrapEnvelope } from "./wrap";

/**
 * Origin-scoped IndexedDB for the local Gun SEA pair + wallet-signed link.
 *
 * Records are either legacy lab plaintext (`seaPair`) or a PRF wrap envelope
 * (`wrap`). Never both. Never sessionStorage, never `user.recall`, never the
 * public Gun graph. Do not write SIWE signatures, SEA `priv` / `epriv`, the
 * envelope, DEK, or KEKs onto a public Gun node.
 */
export const MESH_IDB_NAME = "s3rch-identity";
export const MESH_IDB_VERSION = 1;
export const MESH_STORE_NAME = "mesh-keys";

export type MeshKeyRecordBase = {
  /** Checksummed Ethereum address. Session subject. Never ENS/email/SEA pub. */
  address: string;
  seaPub: string;
  walletSignature: string;
  signedPayload: string;
};

export type PlaintextMeshKeyRecord = MeshKeyRecordBase & {
  seaPair: SeaPair;
};

export type WrappedMeshKeyRecord = MeshKeyRecordBase & {
  wrap: PrfWrapEnvelope;
};

export type MeshKeyRecord = PlaintextMeshKeyRecord | WrappedMeshKeyRecord;

export type MeshKeyStore = {
  get(address: string): Promise<MeshKeyRecord | null>;
  put(record: MeshKeyRecord): Promise<void>;
};

function hasBaseFields(record: Record<string, unknown>): boolean {
  if (typeof record.address !== "string") return false;
  if (typeof record.seaPub !== "string" || record.seaPub.length === 0) return false;
  if (typeof record.walletSignature !== "string" || record.walletSignature.length === 0) {
    return false;
  }
  if (typeof record.signedPayload !== "string" || record.signedPayload.length === 0) {
    return false;
  }
  try {
    getAddress(record.address);
  } catch {
    return false;
  }
  return true;
}

export function isPlaintextMeshKeyRecord(value: unknown): value is PlaintextMeshKeyRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (!hasBaseFields(record)) return false;
  if (record.wrap != null) return false;
  if (!isSeaPair(record.seaPair)) return false;
  return record.seaPair.pub === record.seaPub;
}

export function isWrappedMeshKeyRecord(value: unknown): value is WrappedMeshKeyRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (!hasBaseFields(record)) return false;
  if (record.seaPair != null) return false;
  if (!isPrfWrapEnvelope(record.wrap)) return false;
  try {
    return (
      record.wrap.address === getAddress(String(record.address)) &&
      record.wrap.seaPub === record.seaPub
    );
  } catch {
    return false;
  }
}

export function isMeshKeyRecord(value: unknown): value is MeshKeyRecord {
  return isPlaintextMeshKeyRecord(value) || isWrappedMeshKeyRecord(value);
}

/** Half-written wrap/plaintext hybrid — reject, do not persist or treat as valid. */
export function isHalfWrittenMeshKeyRecord(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (isMeshKeyRecord(value)) return false;
  const record = value as Record<string, unknown>;
  const hasPair = record.seaPair != null;
  const hasWrap = record.wrap != null;
  if (hasPair && hasWrap) return true;
  if (hasWrap) return true;
  if (hasPair) return true;
  return hasBaseFields(record);
}

export function assertCompleteMeshKeyRecord(value: unknown): MeshKeyRecord {
  if (isHalfWrittenMeshKeyRecord(value)) {
    throw new Error("Incomplete mesh key record (half-written wrap).");
  }
  if (!isMeshKeyRecord(value)) {
    throw new Error("Invalid mesh key record.");
  }
  return value;
}

export function meshKeyStorageKind(record: MeshKeyRecord): "plaintext" | "wrapped" {
  return isWrappedMeshKeyRecord(record) ? "wrapped" : "plaintext";
}

export function checksumMeshAddress(address: string): string {
  return getAddress(address);
}

function normalizeRecord(record: MeshKeyRecord): MeshKeyRecord {
  const address = checksumMeshAddress(record.address);
  if (isWrappedMeshKeyRecord(record)) {
    return {
      address,
      seaPub: record.seaPub,
      walletSignature: record.walletSignature,
      signedPayload: record.signedPayload,
      wrap: record.wrap,
    };
  }
  return {
    address,
    seaPub: record.seaPub,
    walletSignature: record.walletSignature,
    signedPayload: record.signedPayload,
    seaPair: record.seaPair,
  };
}

/** In-memory store for node tests. Same contract as IndexedDB. No sessionStorage. */
export function createMemoryMeshKeyStore(
  seed: Iterable<MeshKeyRecord> = [],
): MeshKeyStore {
  const map = new Map<string, MeshKeyRecord>();
  for (const record of seed) {
    assertCompleteMeshKeyRecord(record);
    const stored = normalizeRecord(record);
    map.set(stored.address, stored);
  }
  return {
    async get(address: string) {
      let checksum: string;
      try {
        checksum = checksumMeshAddress(address);
      } catch {
        return null;
      }
      const found = map.get(checksum);
      return found && isMeshKeyRecord(found) ? found : null;
    },
    async put(record: MeshKeyRecord) {
      assertCompleteMeshKeyRecord(record);
      const stored = normalizeRecord(record);
      map.set(stored.address, stored);
    },
  };
}

export function createIndexedDbMeshKeyStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): MeshKeyStore {
  return {
    async get(address: string) {
      let checksum: string;
      try {
        checksum = checksumMeshAddress(address);
      } catch {
        return null;
      }
      const raw = await idbRequest(factory, "readonly", (store) => store.get(checksum));
      return isMeshKeyRecord(raw) && raw.address === checksum ? raw : null;
    },
    async put(record: MeshKeyRecord) {
      assertCompleteMeshKeyRecord(record);
      const stored = normalizeRecord(record);
      await idbRequest(factory, "readwrite", (store) => store.put(stored));
    },
  };
}

let defaultStore: MeshKeyStore | null = null;

export function defaultMeshKeyStore(): MeshKeyStore {
  if (!defaultStore) {
    defaultStore = createIndexedDbMeshKeyStore();
  }
  return defaultStore;
}

export function getMeshKey(
  address: string,
  store: MeshKeyStore = defaultMeshKeyStore(),
): Promise<MeshKeyRecord | null> {
  return store.get(address);
}

export function putMeshKey(
  record: MeshKeyRecord,
  store: MeshKeyStore = defaultMeshKeyStore(),
): Promise<void> {
  return store.put(record);
}

function requireFactory(factory: IDBFactory | undefined): IDBFactory {
  if (!factory) {
    throw new Error("IndexedDB is not available in this runtime.");
  }
  return factory;
}

function openMeshDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(MESH_IDB_NAME, MESH_IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MESH_STORE_NAME)) {
        db.createObjectStore(MESH_STORE_NAME, { keyPath: "address" });
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
  return openMeshDb(dbFactory).then((db) => {
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(MESH_STORE_NAME, mode);
      const request = run(tx.objectStore(MESH_STORE_NAME));
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
