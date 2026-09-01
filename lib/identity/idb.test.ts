import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertCompleteMeshKeyRecord,
  createIndexedDbMeshKeyStore,
  createMemoryMeshKeyStore,
  isHalfWrittenMeshKeyRecord,
  isMeshKeyRecord,
  isPlaintextMeshKeyRecord,
  isWrappedMeshKeyRecord,
  MESH_IDB_NAME,
  MESH_STORE_NAME,
  type PlaintextMeshKeyRecord,
} from "./idb";
import type { SeaPair } from "./sea";
import { wrapSeaPair, type PrfWrapEnvelope } from "./wrap";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function fixturePair(pub = "sea-pub-1"): SeaPair {
  return { pub, priv: "sea-priv-1", epub: "sea-epub-1", epriv: "sea-epriv-1" };
}

function fixtureRecord(overrides: Partial<PlaintextMeshKeyRecord> = {}): PlaintextMeshKeyRecord {
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

async function fixtureEnvelope(): Promise<PrfWrapEnvelope> {
  return wrapSeaPair({
    pair: fixturePair(),
    address: ADDRESS,
    rpId: "localhost",
    credentialId: crypto.getRandomValues(new Uint8Array(16)),
    prfSalt: crypto.getRandomValues(new Uint8Array(32)),
    prfOutput: crypto.getRandomValues(new Uint8Array(32)),
    secondaryKey: crypto.getRandomValues(new Uint8Array(32)),
    secondarySalt: crypto.getRandomValues(new Uint8Array(32)),
    secondaryKind: "wallet",
  });
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

  it("rejects half-written wrap records", async () => {
    const wrap = await fixtureEnvelope();
    const both = { ...fixtureRecord(), wrap };
    const neither = {
      address: ADDRESS,
      seaPub: "sea-pub-1",
      walletSignature: "0xsig",
      signedPayload: "payload",
    };
    const wrapOnlyBroken = {
      ...neither,
      wrap: { version: 1, rpId: "localhost" },
    };
    const mismatch = { ...neither, wrap: { ...wrap, address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" } };

    assert.equal(isHalfWrittenMeshKeyRecord(both), true);
    assert.equal(isMeshKeyRecord(both), false);
    assert.equal(isHalfWrittenMeshKeyRecord(neither), true);
    assert.equal(isHalfWrittenMeshKeyRecord(wrapOnlyBroken), true);
    assert.equal(isHalfWrittenMeshKeyRecord(mismatch), true);
    assert.throws(() => assertCompleteMeshKeyRecord(both), /half-written wrap/);
    assert.throws(() => assertCompleteMeshKeyRecord(neither), /half-written wrap/);

    const complete = { ...neither, wrap };
    assert.equal(isWrappedMeshKeyRecord(complete), true);
    assert.equal(isPlaintextMeshKeyRecord(complete), false);
    assert.equal(isHalfWrittenMeshKeyRecord(complete), false);
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
    assert.ok(isPlaintextMeshKeyRecord(found));
    assert.equal(found.seaPair.priv, "sea-priv-1");
  });

  it("roundtrips a wrapped record without keeping plaintext seaPair", async () => {
    const store = createMemoryMeshKeyStore();
    const wrap = await fixtureEnvelope();
    await store.put({
      address: ADDRESS,
      seaPub: wrap.seaPub,
      walletSignature: "0xsig",
      signedPayload: "payload",
      wrap,
    });
    const found = await store.get(ADDRESS);
    assert.ok(found);
    assert.ok(isWrappedMeshKeyRecord(found));
    assert.equal("seaPair" in found, false);
    await assert.rejects(
      () =>
        store.put({
          address: ADDRESS,
          seaPub: wrap.seaPub,
          walletSignature: "0xsig",
          signedPayload: "payload",
          seaPair: fixturePair(),
          wrap,
        } as unknown as PlaintextMeshKeyRecord),
      /half-written wrap/,
    );
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
    assert.ok(reused && isPlaintextMeshKeyRecord(reused));
    assert.equal(reused.seaPair.epriv, "sea-epriv-1");
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
