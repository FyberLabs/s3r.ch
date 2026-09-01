import { getAddress } from "viem";
import type { SeaPair } from "./sea";

/**
 * Origin-scoped IndexedDB for the local Gun SEA pair + wallet-signed link.
 *
 * Lab slice: the SEA pair is stored plaintext on this device. That is
 * device-local only — never sessionStorage, never `user.recall`, never the
 * public Gun graph. WebAuthn PRF wrap (wrap.ts) will replace this plaintext
 * later. Do not write SIWE signatures, SEA `priv` / `epriv`, or the link
 * onto a public Gun node.
 */
export const MESH_IDB_NAME = "s3rch-identity";
export const MESH_IDB_VERSION = 1;
export const MESH_STORE_NAME = "mesh-keys";

export type MeshKeyRecord = {
  /** Checksummed Ethereum address. Session subject. Never ENS/email/SEA pub. */
  address: string;
  seaPub: string;
  /**
   * Lab plaintext pair. Device-local IndexedDB only.
   * PRF wrap will replace this field later — do not treat as the long-term shape.
   */
  seaPair: SeaPair;
  walletSignature: string;
  signedPayload: string;
};

export type MeshKeyStore = {
  get(address: string): Promise<MeshKeyRecord | null>;
  put(record: MeshKeyRecord): Promise<void>;
};

export function isMeshKeyRecord(value: unknown): value is MeshKeyRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.address !== "string") return false;
  if (typeof record.seaPub !== "string" || record.seaPub.length === 0) return false;
  if (typeof record.walletSignature !== "string" || record.walletSignature.length === 0) {
    return false;
  }
  if (typeof record.signedPayload !== "string" || record.signedPayload.length === 0) {
    return false;
  }
  const pair = record.seaPair;
  if (!pair || typeof pair !== "object") return false;
  const sea = pair as Record<string, unknown>;
  if (typeof sea.pub !== "string" || sea.pub !== record.seaPub) return false;
  if (typeof sea.priv !== "string" || typeof sea.epub !== "string") return false;
  if (typeof sea.epriv !== "string") return false;
  try {
    getAddress(record.address);
  } catch {
    return false;
  }
  return true;
}

export function checksumMeshAddress(address: string): string {
  return getAddress(address);
}

/** In-memory store for node tests. Same contract as IndexedDB. No sessionStorage. */
export function createMemoryMeshKeyStore(
  seed: Iterable<MeshKeyRecord> = [],
): MeshKeyStore {
  const map = new Map<string, MeshKeyRecord>();
  for (const record of seed) {
    const address = checksumMeshAddress(record.address);
    map.set(address, { ...record, address });
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
      const address = checksumMeshAddress(record.address);
      const stored = { ...record, address };
      if (!isMeshKeyRecord(stored)) {
        throw new Error("Invalid mesh key record.");
      }
      map.set(address, stored);
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
      const address = checksumMeshAddress(record.address);
      const stored = { ...record, address };
      if (!isMeshKeyRecord(stored)) {
        throw new Error("Invalid mesh key record.");
      }
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
