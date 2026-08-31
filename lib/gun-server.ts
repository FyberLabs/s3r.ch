import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Server } from "node:http";
import type { FeedItem, FeedSnapshot, GunFeedNode } from "./feed-types";
import { fromGunNode, toGunNode } from "./feed-types";
import { canonicalKey } from "./merge";

type GunAck = { err?: string };
type GunCb = (data: unknown, key: string) => void;

type GunRef = {
  get: (key: string) => GunRef;
  put: (data: unknown, cb?: (ack: GunAck) => void) => GunRef;
  once: (cb: GunCb) => GunRef;
  map: () => { once: (cb: GunCb) => unknown; on: (cb: GunCb) => unknown };
};

type GunFactory = (opts?: Record<string, unknown>) => GunRoot;
type GunRoot = GunRef & { opt?: Record<string, unknown> };

type GlobalGun = typeof globalThis & {
  __s3rchGun?: GunRoot;
  __s3rchStore?: MemoryStore;
};

const GUN_ROOT = "s3rch";
const ITEMS_KEY = "items";
const META_KEY = "meta";

export type MemoryStore = {
  items: Map<string, FeedItem>;
  seededAt: string | null;
  sourcesOk: number;
  sourcesTried: number;
  error: string | null;
};

export function gunFilePath(): string {
  return process.env.GUN_FILE || pathJoinData("radata");
}

export function snapshotPath(): string {
  return process.env.GUN_SNAPSHOT || pathJoinData("snapshot.json");
}

function pathJoinData(name: string): string {
  return `${process.cwd()}/data/${name}`;
}

export function getMemoryStore(): MemoryStore {
  const g = globalThis as GlobalGun;
  if (!g.__s3rchStore) {
    g.__s3rchStore = {
      items: new Map(),
      seededAt: null,
      sourcesOk: 0,
      sourcesTried: 0,
      error: null,
    };
    loadSnapshot(g.__s3rchStore);
  }
  return g.__s3rchStore;
}

export function getServerGun(server?: Server): GunRoot {
  const g = globalThis as GlobalGun & { __s3rchGunHydrated?: boolean };
  if (!g.__s3rchGun) {
    ensureDir(gunFilePath());
    const Gun = loadGun();
    g.__s3rchGun = Gun({
      web: server,
      file: gunFilePath(),
      multicast: false,
      axe: false,
      peers: [],
    });
    if (server) {
      console.log("[s3r.ch] Gun peer attached to HTTP server");
    } else {
      console.log("[s3r.ch] Gun file graph ready at", gunFilePath());
    }
  }
  if (!g.__s3rchGunHydrated) {
    g.__s3rchGunHydrated = true;
    hydrateGunFromStore(g.__s3rchGun, getMemoryStore());
  }
  return g.__s3rchGun;
}

export function attachGunWeb(server: Server): GunRoot {
  return getServerGun(server);
}

export function putItems(items: FeedItem[]): number {
  const store = getMemoryStore();
  const gun = getServerGun();
  let written = 0;
  for (const item of items) {
    const key = canonicalKey(item);
    if (!key) continue;
    store.items.set(key, { ...item, id: key });
    gun.get(GUN_ROOT).get(ITEMS_KEY).get(encodeKey(key)).put(toGunNode({ ...item, id: key }));
    written += 1;
  }
  persistMeta(store);
  persistSnapshot(store);
  return written;
}

export function setSeedMeta(meta: {
  seededAt: string | null;
  sourcesOk: number;
  sourcesTried: number;
  error: string | null;
}): void {
  const store = getMemoryStore();
  store.seededAt = meta.seededAt;
  store.sourcesOk = meta.sourcesOk;
  store.sourcesTried = meta.sourcesTried;
  store.error = meta.error;
  persistMeta(store);
  persistSnapshot(store);
}

export function listSnapshot(): FeedSnapshot {
  const store = getMemoryStore();
  const items = Array.from(store.items.values()).sort(
    (a, b) => (b.ts || 0) - (a.ts || 0) || a.id.localeCompare(b.id),
  );
  return {
    items,
    seededAt: store.seededAt,
    sourcesOk: store.sourcesOk,
    sourcesTried: store.sourcesTried,
    error: store.error,
  };
}

function persistMeta(store: MemoryStore): void {
  const gun = getServerGun();
  gun.get(GUN_ROOT).get(META_KEY).put({
    seededAt: store.seededAt ?? "",
    sourcesOk: store.sourcesOk,
    sourcesTried: store.sourcesTried,
    error: store.error ?? "",
    count: store.items.size,
  });
}

function persistSnapshot(store: MemoryStore): void {
  const path = snapshotPath();
  ensureDir(path);
  const body: FeedSnapshot = {
    items: Array.from(store.items.values()),
    seededAt: store.seededAt,
    sourcesOk: store.sourcesOk,
    sourcesTried: store.sourcesTried,
    error: store.error,
  };
  writeFileSync(/*turbopackIgnore: true*/ path, JSON.stringify(body), "utf8");
}

function loadSnapshot(store: MemoryStore): void {
  try {
    const raw = readFileSync(/*turbopackIgnore: true*/ snapshotPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<FeedSnapshot>;
    if (Array.isArray(parsed.items)) {
      for (const item of parsed.items) {
        const recovered = fromGunNode(item as unknown as GunFeedNode) ?? asFeedItem(item);
        if (recovered) store.items.set(recovered.id, recovered);
      }
    }
    store.seededAt = typeof parsed.seededAt === "string" ? parsed.seededAt : null;
    store.sourcesOk = typeof parsed.sourcesOk === "number" ? parsed.sourcesOk : 0;
    store.sourcesTried = typeof parsed.sourcesTried === "number" ? parsed.sourcesTried : 0;
    store.error = typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    // first boot or empty disk — honest empty graph
  }
}

function hydrateGunFromStore(gun: GunRoot, store: MemoryStore): void {
  for (const item of store.items.values()) {
    gun.get(GUN_ROOT).get(ITEMS_KEY).get(encodeKey(item.id)).put(toGunNode(item));
  }
  persistMeta(store);
}

function asFeedItem(value: unknown): FeedItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  return fromGunNode({
    id: record.id,
    source: typeof record.source === "string" ? record.source : "",
    kind: typeof record.kind === "string" ? record.kind : "",
    author: typeof record.author === "string" ? record.author : "",
    body: typeof record.body === "string" ? record.body : "",
    ts: typeof record.ts === "number" ? record.ts : 0,
    permalink: typeof record.permalink === "string" ? record.permalink : "",
    tags: Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === "string").join(",")
      : typeof record.tags === "string"
        ? record.tags
        : "",
    provenance: typeof record.provenance === "string" ? record.provenance : "",
  });
}

function encodeKey(id: string): string {
  return id.replace(/[.#$[\]]/g, "_");
}

function ensureDir(filePath: string): void {
  mkdirSync(/*turbopackIgnore: true*/ dirname(filePath), { recursive: true });
  // Gun's `file` option is a directory (radisk), not a single file.
  if (!filePath.endsWith(".json")) {
    mkdirSync(/*turbopackIgnore: true*/ filePath, { recursive: true });
  }
}

function loadGun(): GunFactory {
  // Gun is CJS. Keep it out of the Next bundle via serverExternalPackages.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("gun") as GunFactory | { default: GunFactory };
  return typeof mod === "function" ? mod : mod.default;
}
