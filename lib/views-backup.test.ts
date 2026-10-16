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
  writeBackupToGraph,
  BACKUP_FILE_MAX_BYTES,
  type GraphChain,
} from "./views-backup";
import { emptyState, saveView, toggleFavorite, touchRecent } from "./views-store";
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

function fakeGraph(): GraphChain & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const at = (path: string): GraphChain => ({
    get: (k) => at(`${path}/${k}`),
    put: (v, cb) => {
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
  return Object.assign(at("~"), { data });
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
    const altered = { ...b.records[address]!, ct: b.records[address]!.ct.slice(0, -2) + "AA" };
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
    await writeBackupToGraph(g, await buildBackup(s, pair, "w1", 1));
    assert.ok([...g.data.keys()].some((k) => k === "~/s3rch-views/w1"));
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
    assert.equal(await writeBackupToGraph(g, first), "written");
    assert.equal(await writeBackupToGraph(g, second), "written");
    assert.equal(await writeBackupToGraph(g, first), "stale");
    const recordKeys = [...g.data.keys()].filter((k) => k.startsWith("~/s3rch-views-records/w/"));
    assert.equal(recordKeys.length, 3);
    g.data.set(recordKeys[1]!, JSON.stringify({ v: 1, iv: "AAAAAAAAAAAAAAAA", ct: "corrupt" }));
    g.data.delete(recordKeys[0]!);
    const third = await buildBackup(s, pair, "w", 3, cache);
    assert.equal(await writeBackupToGraph(g, third), "written");
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
    assert.deepEqual(r.state.favorites.map((x) => x.source), ["mine", "fav"]);
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
    const { deleteView, TOMBSTONES_MAX, countEntries } = await import("./views-store");
    let local = emptyState(ALICE, "d1");
    local = saveView(local, view("keep", "x")).state;
    const views = { ...local.views };
    for (let i = 0; i < TOMBSTONES_MAX; i++) views[`t${i}`] = { current: { id: `t${i}`, vv: { d1: 1 }, deleted: true }, conflicts: [] };
    local = { ...local, views };
    const remote = deleteView(local, "keep");
    const b = await buildBackup(remote, pair, "w", 1);
    const r = await restoreBackup(local, pair, [b.manifest], async (a) => b.records[a]);
    assert.ok(countEntries(r.state).tombstones <= TOMBSTONES_MAX);
    assert.equal(r.state.views.keep?.current.deleted, undefined);
    assert.equal(r.notices.length, 1);
  });

  it("indexes writers by recency and repairs a missing index entry", async () => {
    const pair = await testPair();
    const g = fakeGraph();
    const s = saveView(emptyState(ALICE, "d1"), view("v1", "x")).state;
    const b = await buildBackup(s, pair, "old", 1);
    await writeBackupToGraph(g, b, undefined, () => 1000);
    await writeBackupToGraph(g, await buildBackup(s, pair, "new", 1), undefined, () => 2000);
    assert.deepEqual(await listGraphWriters(g), ["new", "old"]);
    g.data.delete("~/s3rch-views-writers/old");
    assert.equal(await writeBackupToGraph(g, b), "stale");
    assert.ok(g.data.has("~/s3rch-views-writers/old"));
  });

  it("rejects oversized and malformed files before use", () => {
    assert.equal(parseBackupFile("x".repeat(BACKUP_FILE_MAX_BYTES + 1)).ok, false);
    assert.equal(parseBackupFile("{").ok, false);
    assert.equal(parseBackupFile('{"kind":"other","v":1,"manifests":[],"records":{}}').ok, false);
  });
});
