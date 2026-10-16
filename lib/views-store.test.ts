import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SourceRef } from "./views-source-ref";
import {
  createMemoryViewsStore,
  deleteView,
  emptyState,
  listViews,
  mergeVersion,
  parseState,
  RECENTS_MAX,
  resolveConflict,
  saveView,
  toggleFavorite,
  touchRecent,
  type ViewsState,
  type ViewVersion,
} from "./views-store";
import { bumpVV, compareVV, isVersionVector } from "./views-vv";
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

  it("caps recents, dedupes and keeps most recent first", () => {
    let s = emptyState(ALICE, "d1");
    for (let i = 0; i < RECENTS_MAX + 5; i++) s = touchRecent(s, ref(`r${i}`), i);
    s = touchRecent(s, ref("r10"), 100);
    assert.equal(s.recents.length, RECENTS_MAX);
    assert.equal(s.recents[0]?.ref.source, "r10");
    assert.equal(s.recents.filter((r) => r.ref.source === "r10").length, 1);
  });

  it("rejects reserved view ids", () => {
    assert.throws(() => saveView(emptyState(ALICE, "d1"), view("toString")));
    assert.throws(() => saveView(emptyState(ALICE, "d1"), view("__proto__")));
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
  it("serializes concurrent updates so no edit is lost", async () => {
    const store = createMemoryViewsStore();
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.update(ALICE, "d1", (s) => touchRecent(s, ref(`r${i}`), i))));
    const { state } = await store.read(ALICE, "d1");
    assert.equal(state.recents.length, 10);
  });
});
