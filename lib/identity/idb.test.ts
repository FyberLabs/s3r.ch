import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createIndexedDbMeshKeyStore,
  createMemoryMeshKeyStore,
  isMeshKeyRecord,
  MESH_IDB_NAME,
  MESH_STORE_NAME,
  type MeshKeyRecord,
} from "./idb";
import type { SeaPair } from "./sea";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function fixturePair(pub = "sea-pub-1"): SeaPair {
  return { pub, priv: "sea-priv-1", epub: "sea-epub-1", epriv: "sea-epriv-1" };
}

function fixtureRecord(overrides: Partial<MeshKeyRecord> = {}): MeshKeyRecord {
  const seaPair = overrides.seaPair ?? fixturePair();
  return {
    address: ADDRESS,
    seaPub: seaPair.pub,
    seaPair,
    walletSignature: "0xsig",
    signedPayload: "s3r.ch binds this Gun SEA pub to this Ethereum address.",
    ...overrides,
  };
}

describe("mesh key record guard", () => {
  it("accepts a complete record and rejects secrets-only garbage", () => {
    assert.equal(isMeshKeyRecord(fixtureRecord()), true);
    assert.equal(isMeshKeyRecord({ address: ADDRESS }), false);
    assert.equal(
      isMeshKeyRecord(fixtureRecord({ seaPub: "other", seaPair: fixturePair("sea-pub-1") })),
      false,
    );
  });
});

describe("memory mesh key store (node fake)", () => {
  it("roundtrips by checksummed address", async () => {
    const store = createMemoryMeshKeyStore();
    await store.put(fixtureRecord({ address: ADDRESS.toLowerCase() }));
    const found = await store.get(ADDRESS.toLowerCase());
    assert.ok(found);
    assert.equal(found.address, ADDRESS);
    assert.equal(found.seaPub, "sea-pub-1");
    assert.equal(found.seaPair.priv, "sea-priv-1");
  });

  it("returns null when missing", async () => {
    const store = createMemoryMeshKeyStore();
    assert.equal(await store.get(ADDRESS), null);
  });
});

describe("IndexedDB mesh key helper (node fake factory)", () => {
  it("opens an origin-scoped store and roundtrips a record", async () => {
    const sessionWrites: string[] = [];
    const sessionStorageFake = {
      setItem(key: string) {
        sessionWrites.push(key);
      },
      getItem() {
        return null;
      },
    };
    Object.defineProperty(globalThis, "sessionStorage", {
      value: sessionStorageFake,
      configurable: true,
    });

    const factory = createFakeIdbFactory();
    const store = createIndexedDbMeshKeyStore(factory);
    await store.put(fixtureRecord({ address: ADDRESS.toLowerCase() }));
    const found = await store.get(ADDRESS);
    assert.ok(found);
    assert.equal(found.address, ADDRESS);
    assert.equal(found.seaPub, "sea-pub-1");
    assert.equal(found.walletSignature, "0xsig");
    assert.equal(sessionWrites.length, 0);

    const again = createIndexedDbMeshKeyStore(factory);
    const reused = await again.get(ADDRESS.toLowerCase());
    assert.equal(reused?.seaPair.epriv, "sea-epriv-1");
  });

  it("returns null for an empty store", async () => {
    const store = createIndexedDbMeshKeyStore(createFakeIdbFactory());
    assert.equal(await store.get(ADDRESS), null);
  });
});

type StoreData = { keyPath: string; rows: Map<IDBValidKey, unknown> };

class FakeDb {
  readonly name: string;
  readonly stores = new Map<string, StoreData>();

  constructor(name: string) {
    this.name = name;
  }

  get objectStoreNames() {
    return {
      contains: (storeName: string) => this.stores.has(storeName),
    };
  }

  createObjectStore(storeName: string, options: { keyPath: string }) {
    this.stores.set(storeName, { keyPath: options.keyPath, rows: new Map() });
  }

  transaction(storeName: string) {
    const data = this.stores.get(storeName);
    if (!data) throw new Error(`missing store ${storeName}`);
    return {
      objectStore: () => ({
        get: (key: IDBValidKey) => succeed(data.rows.get(key)),
        put: (value: Record<string, unknown>) => {
          const key = value[data.keyPath] as IDBValidKey;
          data.rows.set(key, value);
          return succeed(key);
        },
      }),
      oncomplete: null as ((ev: Event) => void) | null,
      onabort: null as ((ev: Event) => void) | null,
      error: null,
    };
  }

  close() {}
}

function succeed<T>(result: T) {
  const request: {
    result: T;
    error: null;
    onsuccess: ((ev: Event) => void) | null;
    onerror: ((ev: Event) => void) | null;
  } = { result, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => request.onsuccess?.(new Event("success")));
  return request;
}

function createFakeIdbFactory(): IDBFactory {
  const dbs = new Map<string, FakeDb>();
  return {
    open(name: string) {
      const request: {
        result: FakeDb | undefined;
        error: null;
        onsuccess: ((ev: Event) => void) | null;
        onerror: ((ev: Event) => void) | null;
        onupgradeneeded: ((ev: Event) => void) | null;
      } = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        let db = dbs.get(name);
        const created = !db;
        if (!db) {
          db = new FakeDb(name);
          dbs.set(name, db);
        }
        request.result = db;
        if (created || !db.stores.has(MESH_STORE_NAME)) {
          request.onupgradeneeded?.(new Event("upgradeneeded"));
        }
        request.onsuccess?.(new Event("success"));
      });
      assert.equal(name, MESH_IDB_NAME);
      return request;
    },
  } as unknown as IDBFactory;
}
