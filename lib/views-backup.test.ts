import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SeaPair } from "./identity/sea";
import {
  buildBackup,
  canonicalJson,
  exportBackupFile,
  parseBackupFile,
  restoreBackup,
  restoreBackupFile,
  restoreFromGraph,
  listGraphWriters,
  publishViewsBackup,
  pruneSupersededWriters,
  retryWriterTombstones,
  signWriterTombstone,
  writeBackupToGraph,
  writerSlotKey,
  BACKUP_FILE_MAX_BYTES,
  type GraphChain,
} from "./views-backup";
import { adoptRetirements, emptyState, saveView, toggleFavorite, touchRecent, type ViewsState } from "./views-store";
import { coversCausal } from "./views-vv";
import type { View } from "./views-window";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NET = `s3rch:https://s3r.ch:443;key=${"a".repeat(64)}`;

async function testPair(): Promise<SeaPair> {
  const sign = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const ecdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const s = await crypto.subtle.exportKey("jwk", sign.privateKey);
  const e = await crypto.subtle.exportKey("jwk", ecdh.privateKey);
  return { pub: `${s.x}.${s.y}`, priv: s.d!, epub: `${e.x}.${e.y}`, epriv: e.d! };
}

function view(id: string, title: string): View {
  return {
    id, title, v: 1,
    windows: [{ id: "w1", kind: "chat", mode: "single", sources: [{ network: NET, owner: ALICE, source: "r1", kind: "chat", v: 1 }] }],
    layout: { type: "leaf", windowId: "w1" },
  };
}

function fakeGraph(): GraphChain & { data: Map<string, string>; failDeletes: number; beforePut(fn: ((path: string, value: string | null) => void) | undefined): void } {
  const data = new Map<string, string>();
  const state = { failDeletes: 0, beforePut: undefined as ((path: string, value: string | null) => void) | undefined };
  const at = (path: string): GraphChain => ({
    get: (k) => at(`${path}/${k}`),
    put: (v, cb) => {
      state.beforePut?.(path, v);
      if (v === null && state.failDeletes > 0) {
        state.failDeletes -= 1;
        return cb?.({ err: "unavailable" });
      }
      if (v === null) data.delete(path);
      else data.set(path, v);
      cb?.({});
    },
    once: (cb) => {
      if (data.has(path)) return cb(data.get(path));
      const children: Record<string, string> = {};
      for (const [k, v] of data) if (k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes("/")) children[k.slice(path.length + 1)] = v;
      cb(Object.keys(children).length ? { _: {}, ...children } : undefined);
    },
  });
  const root = at("~") as GraphChain & { data: Map<string, string>; failDeletes: number; beforePut(fn: ((path: string, value: string | null) => void) | undefined): void };
  root.data = data;
  Object.defineProperty(root, "failDeletes", { get: () => state.failDeletes, set: (n: number) => (state.failDeletes = n) });
  root.beforePut = (fn) => {
    state.beforePut = fn;
  };
  return root;
}

describe("canonical JSON", () => {
  it("sorts keys and rejects non-finite numbers", () => {
    assert.equal(canonicalJson({ b: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"b":1}');
    assert.throws(() => canonicalJson({ a: Number.NaN }));
  });
});

describe("backup", () => {
  it("round-trips through a file and merges concurrent copies as conflicts", async () => {
    const pair = await testPair();
    const d1 = saveView(emptyState(ALICE, "d1"), view("v1", "from d1")).state;
    const d2 = saveView(emptyState(ALICE, "d2"), view("v1", "from d2")).state;
    const b1 = await buildBackup(d1, pair, "w-d1", 1);
    const b2 = await buildBackup(d2, pair, "w-d2", 1);
    const exported = exportBackupFile([b1, b2]);
    assert.ok(exported.ok);
    const text = exported.text;
    assert.equal(text.includes("from d1"), false);
    const restored = await restoreBackupFile(emptyState(ALICE, "d3"), pair, text);
    assert.equal(restored.notices.length, 0);
    const entry = restored.state.views.v1;
    assert.ok(entry);
    assert.equal(entry.conflicts.length, 1);
  });

  it("rejects manifests from another key, altered records and wrong owners", async () => {
    const pair = await testPair();
    const other = await testPair();
    const s = saveView(emptyState(ALICE, "d1"), view("v1", "x")).state;
    const b = await buildBackup(s, pair, "w", 1);
    const r1 = await restoreBackup(emptyState(ALICE, "d2"), other, [b.manifest], async (a) => b.records[a]);
    assert.deepEqual(r1.state.views, {});
    assert.equal(r1.notices.length, 1);

    const address = b.manifest.entries[0]!.address;
    // Change the second-to-last character, which always carries data bits (the last one may
    // carry only padding bits, so changing it alone can decode to the same bytes).
    const ct = b.records[address]!.ct;
    const altered = { ...b.records[address]!, ct: ct.slice(0, -2) + (ct.at(-2) === "A" ? "B" : "A") + ct.at(-1) };
    const r2 = await restoreBackup(emptyState(ALICE, "d2"), pair, [b.manifest], async () => altered);
    assert.deepEqual(r2.state.views, {});

    const tampered = { ...b.manifest, seq: 2 };
    const r3 = await restoreBackup(emptyState(ALICE, "d2"), pair, [tampered], async (a) => b.records[a]);
    assert.deepEqual(r3.state.views, {});

    const bob = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const r4 = await restoreBackup(emptyState(bob, "d2"), pair, [b.manifest], async (a) => b.records[a]);
    assert.deepEqual(r4.state.views, {});
  });

  it("uses the highest manifest seq per writer and restores tombstones", async () => {
    const pair = await testPair();
    let s = saveView(emptyState(ALICE, "d1"), view("v1", "x")).state;
    const old = await buildBackup(s, pair, "w", 1);
    const { deleteView } = await import("./views-store");
    s = deleteView(s, "v1");
    const now = await buildBackup(s, pair, "w", 2);
    const records = { ...old.records, ...now.records };
    const r = await restoreBackup(emptyState(ALICE, "d2"), pair, [now.manifest, old.manifest], async (a) => records[a]);
    assert.equal(r.state.views.v1?.current.deleted, true);
  });

  it("round-trips through the user graph copy", async () => {
    const pair = await testPair();
    const s = saveView(emptyState(ALICE, "d1"), view("v1", "graph")).state;
    const g = fakeGraph();
    await writeBackupToGraph(g, await buildBackup(s, pair, "w1", 1), { pub: pair.pub });
    assert.ok([...g.data.keys()].some((k) => k === "~/s3rch-views/w1/1"));
    const r = await restoreFromGraph(emptyState(ALICE, "d2"), pair, g);
    assert.equal(r.state.views.v1?.current.view?.title, "graph");
  });

  it("skips records whose fetch fails and keeps the rest", async () => {
    const pair = await testPair();
    let s = saveView(emptyState(ALICE, "d1"), view("v1", "a")).state;
    s = saveView(s, view("v2", "b")).state;
    const b = await buildBackup(s, pair, "w", 1);
    const first = b.manifest.entries[0]!.address;
    const r = await restoreBackup(emptyState(ALICE, "d2"), pair, [b.manifest], async (a) => {
      if (a === first) throw new Error("unavailable");
      return b.records[a];
    });
    assert.equal(Object.keys(r.state.views).length, 1);
    assert.equal(r.notices.length, 1);
  });

  it("refuses to export a file the importer would reject", async () => {
    const pair = await testPair();
    const s = saveView(emptyState(ALICE, "d1"), view("v1", "a")).state;
    const b = await buildBackup(s, pair, "w", 1);
    const big = { ...b, records: { ...b.records, pad: { v: 1 as const, iv: "", ct: "x".repeat(BACKUP_FILE_MAX_BYTES) } } };
    assert.equal(exportBackupFile([big]).ok, false);
  });

  it("reports instead of exceeding the conflict cap", async () => {
    const pair = await testPair();
    const parts = [];
    for (let i = 0; i < 6; i++) parts.push(await buildBackup(saveView(emptyState(ALICE, `d${i}`), view("v1", `c${i}`)).state, pair, `w${i}`, 1));
    const records = Object.assign({}, ...parts.map((p) => p.records));
    const r = await restoreBackup(emptyState(ALICE, "dx"), pair, parts.map((p) => p.manifest), async (a) => records[a]);
    assert.equal(r.state.views.v1?.conflicts.length, 3);
    assert.equal(r.notices.length, 2);
    const again = await buildBackup(r.state, pair, "wx", 1);
    const r2 = await restoreBackup(emptyState(ALICE, "dy"), pair, [again.manifest], async (a) => again.records[a]);
    assert.equal(r2.state.views.v1?.conflicts.length, 3);
  });

  it("reuses ciphertext for unchanged versions, ignores stale manifests and reclaims old records", async () => {
    const pair = await testPair();
    const cache = new Map();
    let s = saveView(emptyState(ALICE, "d1"), view("v1", "a")).state;
    s = saveView(s, view("v2", "b")).state;
    const first = await buildBackup(s, pair, "w", 1, cache);
    s = saveView(s, view("v2", "b2")).state;
    const second = await buildBackup(s, pair, "w", 2, cache);
    const v1addr = (m: typeof first.manifest) => m.entries.find((e) => e.id === "v1")!.address;
    assert.equal(v1addr(first.manifest), v1addr(second.manifest));
    const g = fakeGraph();
    assert.equal(await writeBackupToGraph(g, first, { pub: pair.pub }), "written");
    assert.equal(await writeBackupToGraph(g, second, { pub: pair.pub }), "written");
    assert.equal(await writeBackupToGraph(g, first, { pub: pair.pub }), "stale");
    const recordKeys = [...g.data.keys()].filter((k) => k.startsWith("~/s3rch-views-records/w/"));
    assert.equal(recordKeys.length, 3);
    g.data.set(recordKeys[1]!, JSON.stringify({ v: 1, iv: "AAAAAAAAAAAAAAAA", ct: "corrupt" }));
    g.data.delete(recordKeys[0]!);
    const third = await buildBackup(s, pair, "w", 3, cache);
    assert.equal(await writeBackupToGraph(g, third, { pub: pair.pub }), "written");
    assert.equal([...g.data.keys()].filter((k) => k.startsWith("~/s3rch-views-records/w/")).length, 3);
    const repaired = await restoreFromGraph(emptyState(ALICE, "d4"), pair, g, ["w"]);
    assert.equal(repaired.notices.length, 0);
    const r = await restoreFromGraph(emptyState(ALICE, "d2"), pair, g, ["w"]);
    assert.equal(r.state.views.v2?.current.view?.title, "b2");
  });

  it("backs up and merges recents and favorites", async () => {
    const pair = await testPair();
    const ref = (source: string) => ({ network: NET, owner: ALICE, source, kind: "chat" as const, v: 1 as const });
    let s = toggleFavorite(emptyState(ALICE, "d1"), ref("fav"));
    s = touchRecent(s, ref("old"), 1);
    const b = await buildBackup(s, pair, "w", 1);
    let local = touchRecent(emptyState(ALICE, "d2"), ref("new"), 5);
    local = toggleFavorite(local, ref("mine"));
    const r = await restoreBackup(local, pair, [b.manifest], async (a) => b.records[a]);
    assert.deepEqual(r.state.recents.map((x) => x.ref.source), ["new", "old"]);
    assert.deepEqual(r.state.favorites.map((x) => x.source), ["fav", "mine"]);
    const tampered = { ...b.manifest, prefs: b.manifest.entries[0]?.address ?? "0".repeat(64) };
    const r2 = await restoreBackup(emptyState(ALICE, "d3"), pair, [tampered], async (a) => b.records[a]);
    assert.equal(r2.state.favorites.length, 0);
  });

  it("applies view limits after merging all manifests", async () => {
    const pair = await testPair();
    const { deleteView, VIEWS_MAX } = await import("./views-store");
    let s = emptyState(ALICE, "d1");
    for (let i = 0; i < VIEWS_MAX; i++) s = saveView(s, view(`z${i}`, "old")).state;
    const first = await buildBackup(s, pair, "w1", 1);
    for (let i = 0; i < VIEWS_MAX; i++) s = deleteView(s, `z${i}`);
    for (let i = 0; i < VIEWS_MAX; i++) s = saveView(s, view(`a${i}`, "new")).state;
    const second = await buildBackup(s, pair, "w2", 1);
    const records = { ...first.records, ...second.records };
    const r = await restoreBackup(emptyState(ALICE, "d2"), pair, [first.manifest, second.manifest], async (a) => records[a]);
    const live = Object.values(r.state.views).filter((e) => !e.current.deleted).length;
    assert.equal(live, VIEWS_MAX);
    assert.equal(r.notices.length, 0);
  });

  it("counts live-to-tombstone transitions against the tombstone limit", async () => {
    const pair = await testPair();
    const { TOMBSTONES_MAX, countEntries } = await import("./views-store");
    let local = emptyState(ALICE, "d1");
    local = saveView(local, view("keep", "x")).state;
    const views = { ...local.views };
    for (let i = 0; i < TOMBSTONES_MAX; i++) views[`t${i}`] = { current: { id: `t${i}`, vv: { d1: 1 }, deleted: true }, conflicts: [] };
    local = { ...local, views };
    const remote = { ...local, views: { ...local.views, keep: { current: { id: "keep", vv: { d1: 2 }, deleted: true as const }, conflicts: [] } } };
    const b = await buildBackup(remote, pair, "w", 1);
    const r = await restoreBackup(local, pair, [b.manifest], async (a) => b.records[a]);
    assert.ok(countEntries(r.state).tombstones <= TOMBSTONES_MAX);
    assert.equal(r.state.views.keep, undefined);
    assert.equal(r.notices.length, 1);
    const older = await buildBackup(saveView(emptyState(ALICE, "d1"), view("keep", "x")).state, pair, "old", 1);
    const again = await restoreBackup(r.state, pair, [older.manifest], async (a) => older.records[a]);
    assert.equal(again.state.views.keep, undefined);
  });

  it("does not reuse cached ciphertext after the key pair changes", async () => {
    const pair = await testPair();
    const next = await testPair();
    const cache = new Map();
    const s = saveView(emptyState(ALICE, "d1"), view("v1", "a")).state;
    await buildBackup(s, pair, "w", 1, cache);
    const b = await buildBackup(s, next, "w", 2, cache);
    const r = await restoreBackup(emptyState(ALICE, "d2"), next, [b.manifest], async (a) => b.records[a]);
    assert.equal(r.notices.length, 0);
    assert.equal(r.state.views.v1?.current.view?.title, "a");
  });

  it("retries record cleanup after a failed delete", async () => {
    const pair = await testPair();
    const g = fakeGraph();
    let s = saveView(emptyState(ALICE, "d1"), view("v1", "a")).state;
    const first = await buildBackup(s, pair, "w", 1);
    await writeBackupToGraph(g, first, { pub: pair.pub });
    s = saveView(s, view("v1", "b")).state;
    const second = await buildBackup(s, pair, "w", 2);
    g.failDeletes = 2;
    assert.equal(await writeBackupToGraph(g, second, { pub: pair.pub }), "written");
    const count = () => [...g.data.keys()].filter((k) => k.startsWith("~/s3rch-views-records/w/")).length;
    assert.equal(count(), 4);
    assert.equal(await writeBackupToGraph(g, second, { pub: pair.pub }), "written");
    assert.equal(count(), 2);
    
  });

  it("merges favorites the same way regardless of manifest order", async () => {
    const pair = await testPair();
    const { FAVORITES_MAX } = await import("./views-store");
    const ref = (source: string) => ({ network: NET, owner: ALICE, source, kind: "chat" as const, v: 1 as const });
    let a = emptyState(ALICE, "d1");
    let b = emptyState(ALICE, "d2");
    for (let i = 0; i < FAVORITES_MAX; i++) {
      a = toggleFavorite(a, ref(`a${i}`));
      b = toggleFavorite(b, ref(`b${i}`));
    }
    const ba = await buildBackup(a, pair, "wa", 1);
    const bb = await buildBackup(b, pair, "wb", 1);
    const records = { ...ba.records, ...bb.records };
    const x = await restoreBackup(emptyState(ALICE, "d3"), pair, [ba.manifest, bb.manifest], async (k) => records[k]);
    const y = await restoreBackup(emptyState(ALICE, "d3"), pair, [bb.manifest, ba.manifest], async (k) => records[k]);
    assert.deepEqual(x.state.favorites, y.state.favorites);
  });

  it("reclaims records left by a failed manifest write", async () => {
    const pair = await testPair();
    const g = fakeGraph();
    const s = saveView(emptyState(ALICE, "d1"), view("v1", "a")).state;
    const first = await buildBackup(s, pair, "w", 1);
    await writeBackupToGraph(g, first, { pub: pair.pub });
    const s2 = saveView(s, view("v1", "b")).state;
    const slot: GraphChain = { get: () => slot, once: (cb) => cb(undefined), put: (_v, cb) => cb?.({ err: "down" }) };
    const writerNode: GraphChain = { get: () => slot, once: (cb) => cb(g.data.get("~/s3rch-views/w")), put: () => undefined };
    const failing: GraphChain = {
      get: (k) => (k === "s3rch-views" ? { get: () => writerNode, once: () => undefined, put: () => undefined } : g.get(k)),
      once: g.once,
      put: g.put,
    };
    await assert.rejects(writeBackupToGraph(failing, await buildBackup(s2, pair, "w", 2), { pub: pair.pub }));
    const s3 = saveView(s2, view("v1", "c")).state;
    await writeBackupToGraph(g, await buildBackup(s3, pair, "w", 3), { pub: pair.pub });
    assert.equal([...g.data.keys()].filter((k) => k.startsWith("~/s3rch-views-records/w/")).length, 2);
  });

  it("refuses to publish a manifest with a bad signature", async () => {
    const pair = await testPair();
    const g = fakeGraph();
    const s = saveView(emptyState(ALICE, "d1"), view("v1", "a")).state;
    const b = await buildBackup(s, pair, "w", 1);
    await writeBackupToGraph(g, b, { pub: pair.pub });
    const forged = { ...b, manifest: { ...b.manifest, seq: 9 } };
    await assert.rejects(writeBackupToGraph(g, forged, { pub: pair.pub }));
    const r = await restoreFromGraph(emptyState(ALICE, "d2"), pair, g);
    assert.equal(r.state.views.v1?.current.view?.title, "a");
  });

  it("keeps a favorite removal over an older writer's copy", async () => {
    const pair = await testPair();
    const ref = (source: string) => ({ network: NET, owner: ALICE, source, kind: "chat" as const, v: 1 as const });
    const a = toggleFavorite(emptyState(ALICE, "dA"), ref("x"));
    const ba = await buildBackup(a, pair, "wA", 1);
    let b = (await restoreBackup(emptyState(ALICE, "dB"), pair, [ba.manifest], async (k) => ba.records[k])).state;
    assert.equal(b.favorites.length, 1);
    b = toggleFavorite(b, ref("x"));
    const bb = await buildBackup(b, pair, "wB", 1);
    const records = { ...ba.records, ...bb.records };
    for (const order of [[ba.manifest, bb.manifest], [bb.manifest, ba.manifest]]) {
      const r = await restoreBackup(emptyState(ALICE, "dC"), pair, order, async (k) => records[k]);
      assert.equal(r.state.favorites.length, 0);
    }
  });

  it("ignores an unverifiable published manifest when checking seq", async () => {
    const pair = await testPair();
    const g = fakeGraph();
    const s = saveView(emptyState(ALICE, "d1"), view("v1", "a")).state;
    const b = await buildBackup(s, pair, "w", 1);
    g.data.set("~/s3rch-views/w", JSON.stringify({ ...b.manifest, seq: Number.MAX_SAFE_INTEGER }));
    assert.equal(await writeBackupToGraph(g, b, { pub: pair.pub }), "written");
  });

  it("refuses to publish a manifest whose records are missing", async () => {
    const pair = await testPair();
    const s = saveView(emptyState(ALICE, "d1"), view("v1", "a")).state;
    const b = await buildBackup(s, pair, "w", 1);
    await assert.rejects(writeBackupToGraph(fakeGraph(), { ...b, records: {} }, { pub: pair.pub }));
  });

  it("treats a re-signed identical manifest as a retry", async () => {
    const pair = await testPair();
    const g = fakeGraph();
    const cache = new Map();
    const s = saveView(emptyState(ALICE, "d1"), view("v1", "a")).state;
    await writeBackupToGraph(g, await buildBackup(s, pair, "w", 1, cache), { pub: pair.pub });
    g.data.delete(`~/s3rch-views-writers/${writerSlotKey("w", 1)}`);
    assert.equal(await writeBackupToGraph(g, await buildBackup(s, pair, "w", 1, cache), { pub: pair.pub }), "written");
    assert.ok(g.data.has(`~/s3rch-views-writers/${writerSlotKey("w", 1)}`));
  });

  it("counts distinct writers toward the restore limit", async () => {
    const pair = await testPair();
    const one = saveView(emptyState(ALICE, "d1"), view("v1", "a")).state;
    const two = saveView(emptyState(ALICE, "d2"), view("v2", "b")).state;
    const history = await Promise.all(Array.from({ length: 20 }, (_, i) => buildBackup(one, pair, "w1", i)));
    const b2 = await buildBackup(two, pair, "w2", 1);
    const records = Object.assign({}, ...history.map((h) => h.records), b2.records);
    const r = await restoreBackup(emptyState(ALICE, "d3"), pair, [...history.map((h) => h.manifest), b2.manifest], async (a) => records[a]);
    assert.equal(r.state.views.v1?.current.view?.title, "a");
    assert.equal(r.state.views.v2?.current.view?.title, "b");
  });

  it("counts only verified manifests toward the restore limit", async () => {
    const pair = await testPair();
    const s = saveView(emptyState(ALICE, "d1"), view("v1", "a")).state;
    const b = await buildBackup(s, pair, "real", 1);
    const bad = Array.from({ length: 20 }, () => ({ ...b.manifest, sig: "x" }));
    const r = await restoreBackup(emptyState(ALICE, "d2"), pair, [...bad, b.manifest], async (a) => b.records[a]);
    assert.equal(r.state.views.v1?.current.view?.title, "a");
  });

  it("skips writer-index entries whose manifest is missing", async () => {
    const pair = await testPair();
    const g = fakeGraph();
    const s = saveView(emptyState(ALICE, "d1"), view("v1", "a")).state;
    await writeBackupToGraph(g, await buildBackup(s, pair, "real", 1), { pub: pair.pub, now: () => 1 });
    for (let i = 0; i < 20; i++) g.data.set(`~/s3rch-views-writers/gone${i}`, String(100 + i));
    const r = await restoreFromGraph(emptyState(ALICE, "d2"), pair, g);
    assert.equal(r.state.views.v1?.current.view?.title, "a");
  });

  it("rejects _ as a writer id and invalid sequence numbers", async () => {
    const pair = await testPair();
    for (const seq of [-1, 1.5, Number.NaN, 2 ** 53]) await assert.rejects(buildBackup(emptyState(ALICE, "d1"), pair, "w", seq));
    await assert.rejects(buildBackup(emptyState(ALICE, "d1"), pair, "_", 1));
  });

  it("indexes writers by recency and repairs a missing index entry", async () => {
    const pair = await testPair();
    const g = fakeGraph();
    const s = saveView(emptyState(ALICE, "d1"), view("v1", "x")).state;
    const b = await buildBackup(s, pair, "old", 1);
    await writeBackupToGraph(g, b, { pub: pair.pub, now: () => 1000 });
    await writeBackupToGraph(g, await buildBackup(s, pair, "new", 1), { pub: pair.pub, now: () => 2000 });
    assert.deepEqual(await listGraphWriters(g), ["new", "old"]);
    g.data.delete(`~/s3rch-views-writers/${writerSlotKey("old", 1)}`);
    assert.equal(await writeBackupToGraph(g, b, { pub: pair.pub }), "written");
    assert.ok(g.data.has(`~/s3rch-views-writers/${writerSlotKey("old", 1)}`));
    const recKey = [...g.data.keys()].find((k) => k.startsWith("~/s3rch-views-records/old/"))!;
    g.data.delete(recKey);
    await writeBackupToGraph(g, b, { pub: pair.pub });
    assert.ok(g.data.has(recKey));
  });

  it("publishes a retirement map before removing a superseded writer and retries a failed removal", async () => {
    const pair = await testPair();
    const g = fakeGraph();
    const first = saveView(emptyState(ALICE, "d1"), view("v1", "old")).state;
    await writeBackupToGraph(g, await buildBackup(first, pair, "w1", 1), { pub: pair.pub });
    const restored = (await restoreFromGraph(emptyState(ALICE, "d2"), pair, g)).state;
    const survivor = saveView(restored, view("v1", "new")).state;
    const plain = await buildBackup(survivor, pair, "w2", 1);
    await writeBackupToGraph(g, plain, { pub: pair.pub });
    assert.deepEqual((await pruneSupersededWriters(g, pair, plain.manifest)).removed, []);
    assert.equal(g.data.has("~/s3rch-views/w1/1"), true);

    const published = await publishViewsBackup(g, pair, survivor, "w2", 2);
    assert.equal(published.status, "written");
    const manifest = JSON.parse(g.data.get("~/s3rch-views/w2/2")!) as { retirements?: { d1?: number } };
    assert.ok((manifest.retirements?.d1 ?? 0) >= 1);
    assert.equal(g.data.has("~/s3rch-views/w1/1"), false);
    assert.equal([...g.data.keys()].some((k) => k.startsWith("~/s3rch-views-records/w1/")), false);
    assert.equal(g.data.has(`~/s3rch-views-writers/${writerSlotKey("w1", 1)}`), false);
    assert.equal([...g.data.keys()].some((k) => k.startsWith("~/s3rch-views-retired/")), false);

    const g2 = fakeGraph();
    await writeBackupToGraph(g2, await buildBackup(first, pair, "w1", 1), { pub: pair.pub });
    const adopted = adoptRetirements(survivor, { d1: 1 });
    const backup = await buildBackup(adopted, pair, "w2", 1);
    await writeBackupToGraph(g2, backup, { pub: pair.pub });
    g2.failDeletes = 1;
    const failed = await pruneSupersededWriters(g2, pair, backup.manifest);
    assert.deepEqual(failed.removed, []);
    assert.equal(g2.data.has("~/s3rch-views/w1/1"), true);
    assert.equal([...g2.data.keys()].some((k) => k.startsWith("~/s3rch-views-retired/")), true);
    const replacement = await buildBackup(saveView(first, view("v1", "nope")).state, pair, "w1", 1);
    assert.equal(await writeBackupToGraph(g2, replacement, { pub: pair.pub }), "stale");
    assert.equal(JSON.parse(g2.data.get("~/s3rch-views/w1/1")!).seq, 1);
    g2.failDeletes = 0;
    assert.deepEqual((await retryWriterTombstones(g2, pair)).pending, []);
    assert.equal(g2.data.has("~/s3rch-views/w1/1"), false);
    assert.equal([...g2.data.keys()].some((k) => k.startsWith("~/s3rch-views-records/w1/")), false);
    assert.equal([...g2.data.keys()].some((k) => k.startsWith("~/s3rch-views-retired/")), false);
    const back = await restoreFromGraph(emptyState(ALICE, "d3"), pair, g);
    assert.equal(back.state.views.v1?.current.view?.title, "new");
  });

  it("leaves a slot whose body is not the one named by the tombstone", async () => {
    const pair = await testPair();
    const g = fakeGraph();
    const s = saveView(emptyState(ALICE, "d1"), view("v1", "stay")).state;
    await writeBackupToGraph(g, await buildBackup(s, pair, "w1", 1), { pub: pair.pub });
    const tomb = await signWriterTombstone(pair, { v: 1, owner: s.owner, writerId: "w1", seq: 1, manifestHash: "ab".repeat(32), deviceId: "d1", counter: 1 });
    g.data.set(`~/s3rch-views-retired/${writerSlotKey("w1", 1)}`, JSON.stringify(tomb));
    assert.deepEqual((await retryWriterTombstones(g, pair)).pending, []);
    assert.equal(g.data.has("~/s3rch-views/w1/1"), true);
    assert.equal(g.data.has(`~/s3rch-views-retired/${writerSlotKey("w1", 1)}`), false);
  });

  it("keeps a publication that arrives while a superseded slot is removed", async () => {
    const pair = await testPair();
    const g = fakeGraph();
    const first = saveView(emptyState(ALICE, "d1"), view("v1", "old")).state;
    await writeBackupToGraph(g, await buildBackup(first, pair, "w1", 1), { pub: pair.pub });
    const survivor = saveView((await restoreFromGraph(emptyState(ALICE, "d2"), pair, g)).state, view("v1", "kept")).state;
    const raced = await buildBackup(saveView(first, view("v1", "raced")).state, pair, "w1", 2);
    g.beforePut((path, value) => {
      if (path === "~/s3rch-views/w1/1" && value === null && !g.data.has("~/s3rch-views/w1/2")) {
        g.data.set("~/s3rch-views/w1/2", JSON.stringify(raced.manifest));
        for (const [address, record] of Object.entries(raced.records)) g.data.set(`~/s3rch-views-records/w1/${address}`, JSON.stringify(record));
        g.data.set(`~/s3rch-views-writers/${writerSlotKey("w1", 2)}`, "9");
      }
    });
    const published = await publishViewsBackup(g, pair, survivor, "w2", 1);
    assert.equal(published.status, "written");
    assert.equal(g.data.has("~/s3rch-views/w1/1"), false);
    assert.equal(g.data.has("~/s3rch-views/w1/2"), true);
    const onlyRaced = await restoreFromGraph(emptyState(ALICE, "d3"), pair, g, ["w1"]);
    assert.equal(onlyRaced.state.views.v1?.current.view?.title, "raced");
  });

  it("does not remove a writer whose newest publication is still concurrent", async () => {
    const pair = await testPair();
    const g = fakeGraph();
    const first = saveView(emptyState(ALICE, "d1"), view("v1", "old")).state;
    await writeBackupToGraph(g, await buildBackup(first, pair, "w1", 1), { pub: pair.pub });
    const survivor = saveView((await restoreFromGraph(emptyState(ALICE, "d2"), pair, g)).state, view("v1", "kept")).state;
    await writeBackupToGraph(g, await buildBackup(saveView(first, view("v1", "raced")).state, pair, "w1", 2), { pub: pair.pub });
    const backup = await buildBackup(adoptRetirements(survivor, { d1: 1 }), pair, "w2", 1);
    await writeBackupToGraph(g, backup, { pub: pair.pub });
    assert.deepEqual((await pruneSupersededWriters(g, pair, backup.manifest)).removed, []);
    assert.equal(g.data.has("~/s3rch-views/w1/2"), true);
    const onlyRaced = await restoreFromGraph(emptyState(ALICE, "d3"), pair, g, ["w1"]);
    assert.equal(onlyRaced.state.views.v1?.current.view?.title, "raced");
  });

  it("merges folded markers against the map each manifest was saved with", async () => {
    const pair = await testPair();
    const marked = (deviceId: string, title: string, retirements: Record<string, number>): ViewsState => ({
      ...emptyState(ALICE, deviceId),
      retirements,
      views: { v1: { current: { id: "v1", vv: {}, foldedAll: true, view: view("v1", title) }, conflicts: [] } },
    });
    const ba = await buildBackup(marked("dA", "A", { d1: 5 }), pair, "wa", 1);
    const bb = await buildBackup(marked("dB", "B", { d2: 5 }), pair, "wb", 1);
    const records = { ...ba.records, ...bb.records };
    const load = (order: [typeof ba.manifest, typeof bb.manifest]) =>
      restoreBackup(emptyState(ALICE, "dx"), pair, order, async (k) => records[k]);
    const x = await load([ba.manifest, bb.manifest]);
    const y = await load([bb.manifest, ba.manifest]);
    const titles = (s: ViewsState) => [s.views.v1?.current.view?.title, ...(s.views.v1?.conflicts ?? []).map((c) => c.view?.title)].sort();
    assert.deepEqual(titles(x.state), ["A", "B"]);
    assert.deepEqual(x.state.views.v1, y.state.views.v1);
  });

  it("hides the same capped copies regardless of manifest order", async () => {
    const pair = await testPair();
    const parts: Awaited<ReturnType<typeof buildBackup>>[] = [];
    for (let i = 0; i < 6; i++) parts.push(await buildBackup(saveView(emptyState(ALICE, `d${i}`), view("v1", `c${i}`)).state, pair, `w${i}`, 1));
    const records = Object.assign({}, ...parts.map((p) => p.records));
    const load = (order: typeof parts) => restoreBackup(emptyState(ALICE, "dx"), pair, order.map((p) => p.manifest), async (a) => records[a]);
    const x = await load(parts);
    const y = await load([...parts].reverse());
    assert.deepEqual(x.state.views.v1, y.state.views.v1);
    const entry = x.state.views.v1!;
    assert.ok(entry.hidden);
    const kept = new Set([entry.current, ...entry.conflicts].map((v) => v.view?.title));
    for (let i = 0; i < 6; i++) if (!kept.has(`c${i}`)) assert.equal(coversCausal(entry.hidden!, { vv: { [`d${i}`]: 1 } }), true);
  });

  it("keeps graph keys and live vectors bounded across repeated restores", async () => {
    const pair = await testPair();
    const g = fakeGraph();
    const count = (prefix: string) => [...g.data.keys()].filter((k) => k.startsWith(prefix)).length;
    let state = saveView(emptyState(ALICE, "d0"), view("v1", "t0")).state;
    let published = await publishViewsBackup(g, pair, state, "w0", 1);
    for (let i = 1; i <= 8; i++) {
      const restored = await restoreFromGraph(emptyState(ALICE, `d${i}`), pair, g);
      assert.equal(restored.notices.length, 0);
      state = saveView(restored.state, view("v1", `t${i}`)).state;
      published = await publishViewsBackup(g, pair, state, `w${i}`, 1);
      assert.equal(published.status, "written");
      assert.equal(count("~/s3rch-views/"), 1);
      assert.ok(count("~/s3rch-views-records/") <= 2);
      assert.equal(count("~/s3rch-views-writers/"), 1);
      assert.equal(count("~/s3rch-views-retired/"), 0);
    }
    assert.deepEqual(await listGraphWriters(g), ["w8"]);
    const current = published.state.views.v1!.current;
    assert.equal(current.view?.title, "t8");
    assert.equal(Object.keys(current.vv).length, 1);
    assert.equal(current.foldedAll, true);
    assert.equal(Object.keys(published.state.retirements).length, 8);
  });

  it("rejects oversized and malformed files before use", () => {
    assert.equal(parseBackupFile("x".repeat(BACKUP_FILE_MAX_BYTES + 1)).ok, false);
    assert.equal(parseBackupFile("{").ok, false);
    assert.equal(parseBackupFile('{"kind":"other","v":1,"manifests":[],"records":{}}').ok, false);
  });
});
