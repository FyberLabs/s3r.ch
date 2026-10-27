import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SourceRef } from "./views-source-ref";
import {
  createMemoryViewsStore,
  deleteView,
  emptyState,
  listViews,
  applyDropped,
  CONFLICTS_MAX,
  mergeVersion,
  mergeVersionChecked,
  parseState,
  RECENTS_MAX,
  VIEWS_MAX,
  resolveConflict,
  saveView,
  toggleFavorite,
  touchRecent,
  type ViewsState,
  type ViewEntry, type ViewVersion,
} from "./views-store";
import { bumpVV, compactCausal, compareVV, coversCausal, isVersionVector, readCausal, unionRetirements } from "./views-vv";
import type { View } from "./views-window";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NET = `s3rch:https://s3r.ch:443;key=${"a".repeat(64)}`;

function ref(source: string): SourceRef {
  return { network: NET, owner: ALICE, source, kind: "chat", v: 1 };
}

function view(id: string, title = "t"): View {
  return { id, title, windows: [{ id: "w1", kind: "chat", mode: "single", sources: [ref("r1")] }], layout: { type: "leaf", windowId: "w1" }, v: 1 };
}

describe("version vectors", () => {
  it("orders vectors without clocks", () => {
    assert.equal(compareVV({ a: 1 }, { a: 1 }), "equal");
    assert.equal(compareVV({ a: 2 }, { a: 1 }), "after");
    assert.equal(compareVV({ a: 1 }, { a: 1, b: 1 }), "before");
    assert.equal(compareVV({ a: 2 }, { a: 1, b: 1 }), "concurrent");
    assert.equal(compareVV({}, { b: 1 }), "before");
    assert.equal(isVersionVector({ toString: 1 }), false);
    assert.throws(() => bumpVV({}, "constructor"));
    assert.throws(() => bumpVV({ d: Number.MAX_SAFE_INTEGER }, "d"), /exhausted/);
  });
});

describe("views state", () => {
  it("saves, bumps the device component, deletes with a dominating tombstone", () => {
    let s = emptyState(ALICE, "d1");
    s = saveView(s, view("v1")).state;
    s = saveView(s, view("v1", "renamed")).state;
    assert.deepEqual(s.views.v1?.current.vv, { d1: 2 });
    assert.equal(listViews(s)[0]?.view.title, "renamed");
    s = deleteView(s, "v1");
    assert.equal(s.views.v1?.current.deleted, true);
    assert.deepEqual(s.views.v1?.current.vv, { d1: 3 });
    assert.equal(listViews(s).length, 0);
  });

  it("rejects an invalid view on save", () => {
    const bad = { ...view("v1"), windows: [{ id: "w1", kind: "chat", mode: "merged", sources: [ref("a"), ref("b")] }] } as unknown as View;
    const r = saveView(emptyState(ALICE, "d1"), bad);
    assert.equal(r.state.views.v1?.current.view?.windows.length, 0);
    assert.equal(r.notices.length, 1);
  });

  it("keeps concurrent versions as conflicts and resolves to a dominating version", () => {
    const a: ViewVersion = { id: "v1", vv: { d1: 2 }, view: view("v1", "A") };
    const b: ViewVersion = { id: "v1", vv: { d1: 1, d2: 1 }, view: view("v1", "B") };
    let entry = mergeVersion(undefined, a);
    entry = mergeVersion(entry, b);
    assert.equal(entry.conflicts.length, 1);
    assert.equal(mergeVersion(entry, { id: "v1", vv: { d1: 1 }, view: view("v1", "old") }), entry);
    let s: ViewsState = { ...emptyState(ALICE, "d3"), views: { v1: entry } };
    assert.equal(listViews(s)[0]?.conflicted, true);
    assert.throws(() => saveView(s, view("v1", "edit")), /resolve/);
    const otherView: ViewVersion = { id: "v2", vv: { d1: 1, d2: 1 }, view: view("v2", "B") };
    assert.throws(() => resolveConflict(s, "v1", otherView));
    assert.throws(() => resolveConflict(s, "v1", { ...b, view: view("v1", "not a copy") }));
    s = resolveConflict(s, "v1", b);
    assert.deepEqual(s.views.v1?.current.vv, { d1: 2, d2: 1, d3: 1 });
    assert.equal(s.views.v1?.conflicts.length, 0);
    assert.equal(mergeVersion(s.views.v1, a), s.views.v1);
    const newer: ViewVersion = { id: "v1", vv: { d1: 3, d2: 1 }, view: view("v1", "C") };
    const merged = mergeVersion(mergeVersion(undefined, a), newer);
    assert.equal(merged.current.view?.title, "C");
    assert.equal(merged.conflicts.length, 0);
  });

  it("picks the same current copy regardless of merge order", () => {
    const a: ViewVersion = { id: "v1", vv: { d1: 2 }, view: view("v1", "A") };
    const b: ViewVersion = { id: "v1", vv: { d1: 1, d2: 1 }, view: view("v1", "B") };
    assert.deepEqual(mergeVersion(mergeVersion(undefined, a), b), mergeVersion(mergeVersion(undefined, b), a));
  });

  it("reports a conflicting copy that cannot be read", () => {
    const v: ViewVersion = { id: "v1", vv: { d1: 1 }, view: view("v1", "a") };
    const stored = { ...emptyState(ALICE, "d1"), views: { v1: { current: v, conflicts: [{ id: "v1", vv: "bad" }] } } };
    const { state: s, notices } = parseState(stored, ALICE, "d1");
    assert.equal(s.views.v1?.conflicts.length, 0);
    assert.ok(notices.some((n) => n.message.includes("conflicting copy")));
  });

  it("keeps the same capped conflicts regardless of arrival order", () => {
    const vs: ViewVersion[] = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: "v1", vv: { [`d${i}`]: 1 }, view: view("v1", `t${i}`) }));
    const fold = (list: ViewVersion[]) => list.reduce<ViewEntry | undefined>((e, v) => mergeVersionChecked(e, v).entry, undefined);
    const folded = fold(vs);
    assert.deepEqual(folded, fold([...vs].reverse()));
    assert.equal(folded?.conflicts.length, CONFLICTS_MAX);
    assert.ok(folded?.hidden);
    const kept = new Set([folded!.current, ...folded!.conflicts].map((v) => v.view?.title));
    for (const v of vs) if (!kept.has(v.view?.title)) assert.ok((folded?.hidden ?? []).some((h) => coversCausal(h, v)));
    let s: ViewsState = { ...emptyState(ALICE, "d9"), views: { v1: folded! } };
    s = resolveConflict(s, "v1", folded!.current);
    for (const v of vs) {
      const after = mergeVersion(s.views.v1, v);
      assert.equal(after, s.views.v1);
    }
  });

  it("folds only a component this stamp has observed", () => {
    const map = { d1: 5 };
    const never = { vv: { d2: 1 } };
    assert.equal(readCausal(never, "d1", map), 0);
    const untouched = compactCausal(never, map);
    assert.equal(untouched.folded, undefined);
    assert.equal(readCausal(untouched, "d1"), 0);
    const seen = compactCausal({ vv: { d1: 5, d2: 1 } }, map);
    assert.equal(seen.vv.d1, undefined);
    assert.equal(seen.folded?.d1, 5);
    assert.equal(readCausal(seen, "d1", map), 5);
    const ahead = compactCausal({ vv: { d1: 6 } }, map);
    assert.equal(ahead.vv.d1, 6);
    assert.equal(ahead.folded, undefined);
  });

  it("caps a retirement union from the full set", () => {
    const left = { a: 1, b: 9 };
    const right = { c: 9, d: 2 };
    assert.deepEqual(unionRetirements([left, right], 2), unionRetirements([right, left], 2));
    assert.deepEqual(unionRetirements([left, right], 2), { b: 9, c: 9 });
  });

  it("keeps a retained copy when hidden stamps would dominate it only together", () => {
    const kept = (title: string, vv: Record<string, number>): ViewVersion => ({ id: "v1", vv, view: view("v1", title) });
    const entry: ViewEntry = {
      current: kept("kept", { a: 1, b: 1 }),
      conflicts: [kept("k0", { c0: 1 }), kept("k1", { c1: 1 }), kept("k2", { c2: 1 })],
      hidden: [{ vv: { a: 2 } }, { vv: { b: 2 } }],
    };
    const duplicate: ViewVersion = { id: "v1", vv: { a: 2 }, view: view("v1", "hidden-a") };
    const merged = mergeVersion(entry, duplicate);
    assert.equal([merged.current, ...merged.conflicts].length, 4);
    assert.ok([merged.current, ...merged.conflicts].some((v) => v.view?.title === "kept"));
    const older: ViewVersion = { id: "v1", vv: { a: 1 }, view: view("v1", "old-a") };
    const suppressed = mergeVersion(entry, older);
    assert.equal([suppressed.current, ...suppressed.conflicts].some((v) => v.view?.title === "old-a"), false);
  });

  it("removes a live copy covered by a dropped deletion", () => {
    const live = saveView(emptyState(ALICE, "d1"), view("v1", "x")).state;
    const next = applyDropped({ ...live, dropped: { v1: { vv: { d1: 2 } } } });
    assert.equal(next.views.v1, undefined);
  });

  it("joins concurrent tombstones into one", () => {
    const a: ViewVersion = { id: "v1", vv: { d1: 2 }, deleted: true };
    const b: ViewVersion = { id: "v1", vv: { d1: 1, d2: 1 }, deleted: true };
    const e = mergeVersion(mergeVersion(undefined, a), b);
    assert.deepEqual(e, { current: { id: "v1", vv: { d1: 2, d2: 1 }, deleted: true }, conflicts: [] });
  });

  it("joins concurrent versions with the same content into one", () => {
    const a: ViewVersion = { id: "v1", vv: { d0: 1, d1: 1 }, view: view("v1", "same") };
    const b: ViewVersion = { id: "v1", vv: { d0: 1, d2: 1 }, view: view("v1", "same") };
    const c: ViewVersion = { id: "v1", vv: { d0: 1, d3: 1 }, view: view("v1", "other") };
    assert.deepEqual(mergeVersion(mergeVersion(undefined, a), b), { current: { id: "v1", vv: { d0: 1, d1: 1, d2: 1 }, view: view("v1", "same") }, conflicts: [] });
    const three = mergeVersion(mergeVersion(mergeVersion(undefined, c), a), b);
    assert.equal(three.conflicts.length, 1);
    assert.deepEqual([three.current, ...three.conflicts].map((v) => v.view!.title).sort(), ["other", "same"]);
  });

  it("caps recents, dedupes and keeps most recent first", () => {
    let s = emptyState(ALICE, "d1");
    for (let i = 0; i < RECENTS_MAX + 5; i++) s = touchRecent(s, ref(`r${i}`), i);
    s = touchRecent(s, ref("r10"), 100);
    assert.equal(s.recents.length, RECENTS_MAX);
    assert.equal(s.recents[0]?.ref.source, "r10");
    assert.equal(s.recents.filter((r) => r.ref.source === "r10").length, 1);
  });

  it("frees live capacity after deletion", () => {
    let s = emptyState(ALICE, "d1");
    for (let i = 0; i < VIEWS_MAX; i++) s = saveView(s, view(`v${i}`)).state;
    assert.throws(() => saveView(s, view("extra")));
    s = deleteView(s, "v0");
    s = saveView(s, view("extra")).state;
    assert.equal(listViews(s).length, VIEWS_MAX);
    s = deleteView(s, "v1");
    s = saveView(s, view("extra2")).state;
    assert.throws(() => saveView(s, view("v1")), /at most/);
  });

  it("refuses a delete that would exceed the tombstone limit", async () => {
    const { TOMBSTONES_MAX } = await import("./views-store");
    let s = saveView(emptyState(ALICE, "d1"), view("keep")).state;
    const views = { ...s.views };
    for (let i = 0; i < TOMBSTONES_MAX; i++) views[`t${i}`] = { current: { id: `t${i}`, vv: { d1: 1 }, deleted: true }, conflicts: [] };
    s = { ...s, views };
    assert.throws(() => deleteView(s, "keep"), /deleted views/);
  });

  it("applies live and tombstone limits when loading stored state", () => {
    const views: Record<string, unknown> = {};
    for (let i = 0; i < VIEWS_MAX + 5; i++) views[`v${i}`] = { current: { id: `v${i}`, vv: { d1: 1 }, view: view(`v${i}`) }, conflicts: [] };
    const { state, notices } = parseState({ owner: ALICE, deviceId: "x", v: 1, views, recents: [], favorites: [] }, ALICE, "d1");
    assert.equal(Object.keys(state.views).length, VIEWS_MAX);
    assert.equal(notices.length, 5);
  });

  it("refuses resolving to a deletion past the tombstone limit", async () => {
    const { TOMBSTONES_MAX } = await import("./views-store");
    const del: ViewVersion = { id: "c", vv: { d2: 1 }, deleted: true };
    let s: ViewsState = { ...emptyState(ALICE, "d1"), views: { c: { current: { id: "c", vv: { d1: 1 }, view: view("c") }, conflicts: [del] } } };
    const views = { ...s.views };
    for (let i = 0; i < TOMBSTONES_MAX; i++) views[`t${i}`] = { current: { id: `t${i}`, vv: { d1: 1 }, deleted: true }, conflicts: [] };
    s = { ...s, views };
    assert.throws(() => resolveConflict(s, "c", del), /deleted views/);
  });

  it("rejects reserved view ids", () => {
    assert.throws(() => saveView(emptyState(ALICE, "d1"), view("toString")));
    assert.throws(() => saveView(emptyState(ALICE, "d1"), view("__proto__")));
  });

  it("orders recents by time even when updates arrive out of order", () => {
    let s = touchRecent(emptyState(ALICE, "d1"), ref("new"), 100);
    s = touchRecent(s, ref("old"), 50);
    assert.deepEqual(s.recents.map((r) => r.ref.source), ["new", "old"]);
  });

  it("keeps the newer reference when an older touch arrives", () => {
    const newer = { ...ref("x"), bindingHash: "b".repeat(64) };
    let s = touchRecent(emptyState(ALICE, "d1"), newer, 100);
    s = touchRecent(s, ref("x"), 50);
    assert.deepEqual(s.recents[0], { ref: newer, at: 100 });
  });

  it("toggles favorites", () => {
    let s = toggleFavorite(emptyState(ALICE, "d1"), ref("a"));
    assert.equal(s.favorites.length, 1);
    s = toggleFavorite(s, { ...ref("a"), bindingHash: "b".repeat(64) });
    assert.equal(s.favorites.length, 0);
  });

  it("drops unreadable stored entries and wrong owners", () => {
    const raw = {
      owner: ALICE, deviceId: "x", v: 1,
      views: { v1: { current: { id: "v1", vv: { d1: 1 }, view: view("v1") }, conflicts: [] }, v2: { current: { id: "zz", vv: {} } } },
      recents: [{ ref: ref("a"), at: 1 }, { ref: { bad: 1 }, at: 2 }],
      favorites: [ref("a"), ref("a")],
    };
    const { state, notices } = parseState(raw, ALICE, "d9");
    assert.deepEqual(Object.keys(state.views), ["v1"]);
    assert.equal(state.deviceId, "d9");
    assert.equal(state.recents.length, 1);
    assert.equal(state.favorites.length, 1);
    assert.equal(notices.length, 1);
    assert.deepEqual(parseState({ ...raw, owner: ALICE.toLowerCase() }, ALICE, "d9").state.views, {});
  });
});

describe("store", () => {
  it("shares the fallback lock across separately created stores", async () => {
    const { defaultLock } = await import("./views-store");
    const order: string[] = [];
    const a = defaultLock();
    const b = defaultLock();
    await Promise.all([
      a("k", async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 10));
        order.push("a-end");
      }),
      b("k", async () => {
        order.push("b");
      }),
    ]);
    assert.deepEqual(order, ["a-start", "a-end", "b"]);
  });

  it("returns load notices from update", async () => {
    const store = createMemoryViewsStore();
    await store.update(ALICE, "d1", (s) => ({ ...s, views: { bad: { current: { id: "bad", vv: { d1: 1 }, view: { nope: 1 } }, conflicts: [] } } }) as unknown as ViewsState);
    const r = await store.update(ALICE, "d1", (s) => s);
    assert.equal(r.notices.length, 1);
  });

  it("serializes concurrent updates so no edit is lost", async () => {
    const store = createMemoryViewsStore();
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.update(ALICE, "d1", (s) => touchRecent(s, ref(`r${i}`), i))));
    const { state } = await store.read(ALICE, "d1");
    assert.equal(state.recents.length, 10);
  });
});
