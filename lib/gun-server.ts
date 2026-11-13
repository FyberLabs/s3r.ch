import { mkdirSync, renameSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { publishPublicFeed } from "../public-feed-cache.cjs";
import { dirname } from "node:path";
import type { Server } from "node:http";
import type { FeedItem, FeedSnapshot, GunFeedNode, SourcePull } from "./feed-types";
import { fromGunNode, toGunNode } from "./feed-types";
import { canonicalKey } from "./merge";
import { reconcileSourceWindows, type SourceCache } from "./source-windows";
import { itemUnshareTombstone } from "./unshare";

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

export type MemoryStore = SourceCache & {
  tenantRecordInitialized?: boolean;
  localSnapshotInvalid?: boolean;
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
      windows: new Map(),
      retired: new Set(),
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

/** Persist removals before publishing them, so a restart replays body-free tombstones. */
export function applySourcePull(pull: SourcePull, seededAt: string): number {
  const store = getMemoryStore();
  const next: MemoryStore = { ...store, ...reconcileSourceWindows(store, pull),
    seededAt, sourcesOk: pull.sourcesOk, sourcesTried: pull.sourcesTried, error: pull.error };
  persistSnapshot(next);
  Object.assign(store, next);
  const gun = getServerGun();
  publishStoreItems(gun, store);
  persistMeta(store);
  publishPublicFeed(process.cwd(), listSnapshot());
  return new Set((pull.windows ?? []).flatMap(window => window.items.map(canonicalKey)).filter(Boolean)).size;
}

/** Persist adoption before any remote mutation; leave cached content unchanged. */
export function markTenantFeedAdopted(): void {
  const store = getMemoryStore();
  if (store.tenantRecordInitialized) return;
  persistSnapshot({ ...store, tenantRecordInitialized: true });
  store.tenantRecordInitialized = true;
}

/** Publish only a committed tenant snapshot; disk and Gun remain derived caches. */
export function publishAuthoritativeFeed(next: MemoryStore): void {
  const store = getMemoryStore();
  // A stale local graph may contain rows removed by another writer.
  const retired = new Set([...store.retired, ...next.retired]);
  for (const id of next.items.keys()) retired.delete(id);
  for (const id of store.items.keys()) if (!next.items.has(id)) retired.add(id);
  const installed = { ...next, retired, tenantRecordInitialized: true };
  persistSnapshot(installed);
  Object.assign(store, installed);
  const gun = getServerGun();
  publishStoreItems(gun, store);
  persistMeta(store);
  publishPublicFeed(process.cwd(), listSnapshot());
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
  publishPublicFeed(process.cwd(), listSnapshot());
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
  const body = {
    tenantRecordInitialized: store.tenantRecordInitialized === true,
    sourceWindows: [...store.windows],
    retiredIds: [...store.retired],
    items: Array.from(store.items.values()),
    seededAt: store.seededAt,
    sourcesOk: store.sourcesOk,
    sourcesTried: store.sourcesTried,
    error: store.error,
  };
  const temporary = path + "." + process.pid + ".tmp";
  try {
    writeFileSync(/*turbopackIgnore: true*/ temporary, JSON.stringify(body), "utf8");
    renameSync(/*turbopackIgnore: true*/ temporary, /*turbopackIgnore: true*/ path);
  } finally {
    rmSync(/*turbopackIgnore: true*/ temporary, { force: true });
  }
}

function loadSnapshot(store: MemoryStore): void {
  try {
    const raw = readFileSync(/*turbopackIgnore: true*/ snapshotPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<FeedSnapshot> & { sourceWindows?: unknown; retiredIds?: unknown; tenantRecordInitialized?: unknown };
    if (!Array.isArray(parsed.items) ||
        (parsed.sourceWindows !== undefined && !Array.isArray(parsed.sourceWindows)) ||
        (parsed.retiredIds !== undefined && !Array.isArray(parsed.retiredIds))) throw new Error("Invalid snapshot");
    store.tenantRecordInitialized = parsed.tenantRecordInitialized === true;
    if (Array.isArray(parsed.sourceWindows)) {
      for (const entry of parsed.sourceWindows) {
        if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" &&
            Array.isArray(entry[1])) {
          const rows = entry[1].map((row: unknown) => asFeedItem(row));
          if (!rows.every((row: FeedItem | null) => row !== null)) throw new Error("Invalid snapshot window");
          store.windows.set(entry[0], rows);
        } else throw new Error("Invalid snapshot window");
      }
    }
    if (Array.isArray(parsed.retiredIds)) {
      for (const id of parsed.retiredIds) {
        if (typeof id !== "string") throw new Error("Invalid snapshot tombstone");
        store.retired.add(id);
      }
    }
    if (Array.isArray(parsed.items)) {
      for (const item of parsed.items) {
        const recovered = fromGunNode(item as unknown as GunFeedNode) ?? asFeedItem(item);
        if (!recovered) throw new Error("Invalid snapshot item");
        if (!store.retired.has(recovered.id)) store.items.set(recovered.id, recovered);
      }
    }
    store.seededAt = typeof parsed.seededAt === "string" ? parsed.seededAt : null;
    store.sourcesOk = typeof parsed.sourcesOk === "number" ? parsed.sourcesOk : 0;
    store.sourcesTried = typeof parsed.sourcesTried === "number" ? parsed.sourcesTried : 0;
    store.error = typeof parsed.error === "string" ? parsed.error : null;
  } catch (error) {
    // A missing first-boot file is distinct from unreadable/corrupt data.
    store.localSnapshotInvalid = (error as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
}

function publishStoreItems(gun: GunRoot, store: MemoryStore): void {
  // Existing mesh keys use lossy encoding. Publish surviving rows last so an
  // expired colliding ID cannot hide a retained row at the same key.
  for (const id of store.retired) {
    gun.get(GUN_ROOT).get(ITEMS_KEY).get(encodeKey(id)).put(itemUnshareTombstone(id));
  }
  for (const item of store.items.values()) {
    gun.get(GUN_ROOT).get(ITEMS_KEY).get(encodeKey(item.id)).put({ ...toGunNode(item), unshared: null });
  }
}

function hydrateGunFromStore(gun: GunRoot, store: MemoryStore): void {
  publishStoreItems(gun, store);
  persistMeta(store);
}

function asFeedItem(value: unknown): FeedItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  return fromGunNode({
    id: record.id,
    media: record.media,
    replyTo: record.replyTo,
    root: record.root,
    v: record.v,
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
