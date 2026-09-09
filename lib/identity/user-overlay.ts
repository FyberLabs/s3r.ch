/**
 * Mine overlay GunUserNode. Same shape as s3rch/users/<wallet>, stored
 * locally (memory / origin IndexedDB). Not a public put. Holding a
 * claim is not publishing it. No SIWE / SEA secrets.
 */

import { getAddress } from "viem";
import {
  fromGunUserNode,
  toGunUserNode,
  userNodeHasForbiddenSecrets,
  type User,
} from "@/lib/users";

export const USER_OVERLAY_IDB_NAME = "s3rch-user-overlay";
export const USER_OVERLAY_IDB_VERSION = 1;
export const USER_OVERLAY_STORE_NAME = "users";

export type MineUserOverlayRecord = {
  address: string;
  id: string;
  indicators: string;
  provenance: string;
  ts: number;
  v?: number;
};

export type UserOverlayStore = {
  get(address: string): Promise<User | null>;
  put(user: User): Promise<void>;
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
] as const;

export function overlayRecordHasForbiddenSecrets(value: object): boolean {
  return (
    userNodeHasForbiddenSecrets(value) ||
    FORBIDDEN_SECRET_KEYS.some((key) => key in value)
  );
}

export function userToOverlayRecord(user: User): MineUserOverlayRecord {
  const node = toGunUserNode(user);
  return {
    address: user.id,
    id: node.id,
    indicators: node.indicators,
    provenance: node.provenance,
    ts: node.ts,
    v: node.v,
  };
}

export function overlayRecordToUser(value: unknown): User | null {
  if (!value || typeof value !== "object") return null;
  if (overlayRecordHasForbiddenSecrets(value)) return null;
  const record = value as Record<string, unknown>;
  const user = fromGunUserNode(record);
  if (!user) return null;
  if (typeof record.address === "string" && record.address.trim()) {
    try {
      if (getAddress(record.address) !== user.id) return null;
    } catch {
      return null;
    }
  }
  return user;
}

export function createMemoryUserOverlayStore(
  seed: Iterable<User> = [],
): UserOverlayStore {
  const map = new Map<string, User>();
  for (const user of seed) {
    const record = overlayRecordToUser(userToOverlayRecord(user));
    if (record) map.set(record.id, record);
  }
  return {
    async get(address: string) {
      let checksum: string;
      try {
        checksum = getAddress(address);
      } catch {
        return null;
      }
      return map.get(checksum) ?? null;
    },
    async put(user: User) {
      const record = overlayRecordToUser(userToOverlayRecord(user));
      if (!record) throw new Error("Invalid Mine overlay user node.");
      map.set(record.id, record);
    },
  };
}

export function createIndexedDbUserOverlayStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): UserOverlayStore {
  return {
    async get(address: string) {
      let checksum: string;
      try {
        checksum = getAddress(address);
      } catch {
        return null;
      }
      try {
        const raw = await idbRequest(factory, "readonly", (store) =>
          store.get(checksum),
        );
        const user = overlayRecordToUser(raw);
        return user && user.id === checksum ? user : null;
      } catch {
        return null;
      }
    },
    async put(user: User) {
      const record = overlayRecordToUser(userToOverlayRecord(user));
      if (!record) throw new Error("Invalid Mine overlay user node.");
      await idbRequest(factory, "readwrite", (store) => store.put(record));
    },
  };
}

let defaultStore: UserOverlayStore | null = null;

export function defaultUserOverlayStore(): UserOverlayStore {
  if (!defaultStore) {
    defaultStore = createIndexedDbUserOverlayStore();
  }
  return defaultStore;
}

export function getMineUserOverlay(
  address: string,
  store: UserOverlayStore = defaultUserOverlayStore(),
): Promise<User | null> {
  return store.get(address);
}

export function putMineUserOverlay(
  user: User,
  store: UserOverlayStore = defaultUserOverlayStore(),
): Promise<void> {
  return store.put(user);
}

function requireFactory(factory: IDBFactory | undefined): IDBFactory {
  if (!factory) {
    throw new Error("IndexedDB is not available in this runtime.");
  }
  return factory;
}

function openUserOverlayDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(USER_OVERLAY_IDB_NAME, USER_OVERLAY_IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(USER_OVERLAY_STORE_NAME)) {
        db.createObjectStore(USER_OVERLAY_STORE_NAME, { keyPath: "address" });
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
  return openUserOverlayDb(dbFactory).then((db) => {
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(USER_OVERLAY_STORE_NAME, mode);
      const request = run(tx.objectStore(USER_OVERLAY_STORE_NAME));
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
