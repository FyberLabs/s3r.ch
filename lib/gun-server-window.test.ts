import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySourcePull, publishAuthoritativeFeed, getMemoryStore, getServerGun, listSnapshot } from "./gun-server";
import type { FeedItem, SourcePull } from "./feed-types";

const row: FeedItem = { id: "source-post", source: "rss", kind: "post", author: "a",
  body: "content that must be purged", ts: 1, permalink: "https://example.org/post", tags: [], provenance: "rss:fixture" };
const pull = (items: FeedItem[]): SourcePull => ({ items, windows: [{ key: "feed", items }], completeSources: ["rss"],
  sourcesOk: 1, sourcesTried: 1, error: null });

test("removed bodies disappear from snapshots and Gun, including after reopening the persisted cache", () => {
  const directory = mkdtempSync(join(tmpdir(), "s3rch-window-unit-"));
  const oldCwd = process.cwd(), oldSnapshot = process.env.GUN_SNAPSHOT;
  const globals = globalThis as typeof globalThis & { __s3rchGun?: unknown; __s3rchStore?: unknown; __s3rchGunHydrated?: boolean };
  const old = [globals.__s3rchGun, globals.__s3rchStore, globals.__s3rchGunHydrated] as const;
  const graph = new Map<string, Record<string, unknown>>();
  function ref(path = "") {
    return { get: (key: string) => ref(path + "/" + key), put: (value: Record<string, unknown>) => {
      graph.set(path, { ...graph.get(path), ...value }); return ref(path);
    } };
  }
  try {
    mkdirSync(join(directory, "public/feed-cache"), { recursive: true });
    process.chdir(directory);
    process.env.GUN_SNAPSHOT = join(directory, "snapshot.json");
    globals.__s3rchGun = ref(); delete globals.__s3rchStore; delete globals.__s3rchGunHydrated;
    applySourcePull(pull([row]), "2026-11-11T00:00:00Z");
    assert.equal(listSnapshot().items.length, 1);
    applySourcePull(pull([]), "2026-11-11T01:00:00Z");
    assert.deepEqual(listSnapshot().items, []);
    for (const file of ["snapshot.json", "public/feed-cache/snapshot.json"]) {
      assert.equal(readFileSync(join(directory, file), "utf8").includes(row.body), false);
    }
    assert.equal(graph.get("/s3rch/items/source-post")?.body, null);
    assert.equal(graph.get("/s3rch/items/source-post")?.unshared, 1);
    // Model an old Gun disk row surviving an interrupted write; replay must clear it.
    graph.set("/s3rch/items/source-post", { ...row });
    delete globals.__s3rchStore; delete globals.__s3rchGunHydrated;
    assert.deepEqual([...getMemoryStore().items], []);
    getServerGun();
    assert.equal(graph.get("/s3rch/items/source-post")?.body, null);
    assert.equal(graph.get("/s3rch/items/source-post")?.unshared, 1);
    applySourcePull(pull([row]), "2026-11-11T02:00:00Z");
    assert.equal(graph.get("/s3rch/items/source-post")?.unshared, null, "returning item clears the tombstone");
    assert.equal(listSnapshot().items[0]?.body, row.body);
    // An authoritative empty tenant record clears a stale local row and persists
    // the adoption marker so a missing remote record cannot reimport this disk.
    publishAuthoritativeFeed({ items: new Map(), windows: new Map(), retired: new Set(),
      seededAt: null, sourcesOk: 1, sourcesTried: 1, error: null });
    assert.equal(graph.get("/s3rch/items/source-post")?.body, null);
    delete globals.__s3rchStore;
    assert.equal(getMemoryStore().tenantRecordInitialized, true);
    assert.equal(getMemoryStore().items.size, 0);
    applySourcePull(pull([row]), "2026-11-11T02:30:00Z");
    // A failed durable commit must not publish or mutate the current cache.
    process.env.GUN_SNAPSHOT = directory;
    assert.throws(() => applySourcePull(pull([]), "2026-11-11T03:00:00Z"));
    assert.equal(listSnapshot().items[0]?.body, row.body);
    assert.equal(graph.get("/s3rch/items/source-post")?.body, row.body);
  } finally {
    process.chdir(oldCwd);
    if (oldSnapshot === undefined) delete process.env.GUN_SNAPSHOT; else process.env.GUN_SNAPSHOT = oldSnapshot;
    [globals.__s3rchGun, globals.__s3rchStore, globals.__s3rchGunHydrated] = old;
    rmSync(directory, { recursive: true, force: true });
    rmSync(directory + "." + process.pid + ".tmp", { force: true });
  }
});
