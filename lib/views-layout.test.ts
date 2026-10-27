import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccessState } from "./views-access";
import type { ObservedRow } from "./views-decorators";
import {
  addedSources,
  boundary,
  createLayoutSaveQueue,
  drainLayoutSaves,
  editView,
  keyAction,
  leafOrder,
  markSeen,
  mergeSeen,
  MIN_SPLIT_SIZE,
  minShare,
  openView,
  parseSeen,
  resizeSplit,
  seenBaseline,
  seenNow,
  settleView,
  shouldAdoptSavedLayout,
  unreadCount,
  type KeyInput,
} from "./views-layout";
import { formatCanonical, type SourceRef } from "./views-source-ref";
import { emptyState, mergeVersion, resolveConflict, saveView } from "./views-store";
import type { LayoutTree, View, ViewWindow } from "./views-window";

const leaf = (windowId: string): LayoutTree => ({ type: "leaf", windowId });
const TREE: LayoutTree = {
  type: "split",
  dir: "row",
  sizes: [0.5, 0.5],
  children: [leaf("a"), { type: "split", dir: "col", sizes: [0.6, 0.4], children: [leaf("b"), leaf("c")] }],
};

describe("layout", () => {
  it("lists windows in reading order", () => {
    assert.deepEqual(leafOrder(TREE), ["a", "b", "c"]);
    assert.deepEqual(leafOrder(null), []);
  });

  it("resizes neighbours within bounds and leaves others alone", () => {
    const t = resizeSplit(TREE, [1], 0, 0.1);
    assert.equal(t.type === "split" && t.children[1]!.type === "split" && t.children[1]!.sizes.map((s) => +s.toFixed(2)).join(), "0.7,0.3");
    assert.equal(t.type === "split" && t.sizes.join(), "0.5,0.5");
    const far = resizeSplit(TREE, [], 0, 5);
    assert.equal(far.type === "split" && +far.sizes[1]!.toFixed(6), MIN_SPLIT_SIZE);
    const neg = resizeSplit(TREE, [], 0, -5);
    assert.equal(neg.type === "split" && +neg.sizes[0]!.toFixed(6), MIN_SPLIT_SIZE);
    assert.equal(resizeSplit(TREE, [0], 0, 0.1), TREE);
    assert.equal(resizeSplit(TREE, [], 1, 0.1), TREE);
    assert.equal(resizeSplit(TREE, [], 0, Number.NaN), TREE);
  });

  it("places each border at the sum of the shares before it", () => {
    assert.equal(boundary([0.3, 0.4, 0.3], 1), 0.3);
    assert.ok(Math.abs(boundary([0.3, 0.4, 0.3], 2) - 0.7) < 1e-9);
  });

  it("keeps a row of 12 windows resizable by taking space from further neighbours", () => {
    const n = 12;
    const row: LayoutTree = { type: "split", dir: "row", sizes: Array(n).fill(1 / n), children: Array.from({ length: n }, (_, i) => leaf(`w${i}`)) };
    const t = resizeSplit(row, [], 0, 0.2);
    assert.ok(t !== row && t.type === "split");
    if (t.type !== "split") return;
    assert.ok(Math.abs(t.sizes[0]! - (1 / n + 0.2)) < 1e-9);
    assert.ok(t.sizes.every((s) => s >= minShare(n) - 1e-9));
    assert.ok(Math.abs(t.sizes.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    const back = resizeSplit(row, [], n - 2, -0.1);
    assert.ok(back.type === "split" && back.sizes[n - 1]! > 1 / n);
  });
});

describe("unread", () => {
  const ME = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const NET = `s3rch:https://s3r.ch:443;key=${"a".repeat(64)}`;
  const ref = (source: string): SourceRef => ({ network: NET, owner: ME, source, kind: "chat", v: 1 });
  const w: ViewWindow = { id: "w", kind: "chat", mode: "tabs", sources: [ref("a"), ref("b")] };
  const obs = (source: SourceRef, id: string, observedAt: number): ObservedRow => ({
    row: { key: `${formatCanonical(source)}#${id}`, source, id, author: "x", body: id, ts: observedAt },
    observedAt,
  });
  const read: AccessState = { kind: "read", post: false };

  it("counts readable rows from the window's sources observed after it was seen", () => {
    const rows = [obs(ref("a"), "1", 100), obs(ref("a"), "2", 200), obs(ref("a"), "2", 210), obs(ref("b"), "3", 300), obs(ref("z"), "4", 300)];
    assert.equal(unreadCount(w, rows, () => read, 150), 2);
    assert.equal(unreadCount(w, rows, (r) => (r.source === "b" ? { kind: "locked", reason: "no-grant" } : read), 150), 1);
    assert.equal(unreadCount(w, rows, () => read, undefined), 0);
  });

  it("counts a row seen again by its first observation", () => {
    const rows = [obs(ref("a"), "1", 100), obs(ref("a"), "1", 200)];
    assert.equal(unreadCount(w, rows, () => read, 150), 0);
  });

  it("keeps a row that arrives later in the cursor's second", () => {
    const late = obs(ref("a"), "late", 100);
    // Left near the start of second 100; the row is stamped with that whole second.
    assert.equal(seenNow(100_050), 100.05);
    assert.equal(unreadCount(w, [late], () => read, 100), 1);
    assert.equal(unreadCount(w, [late], () => read, seenNow(100_050)), 1);
    assert.equal(unreadCount(w, [obs(ref("a"), "old", 99)], () => read, seenNow(100_050)), 0);
    // Sub-second observations stay ordered against the same cursor.
    assert.equal(unreadCount(w, [obs(ref("a"), "before", 100.02)], () => read, seenNow(100_050)), 0);
    assert.equal(unreadCount(w, [obs(ref("a"), "after", 100.9)], () => read, seenNow(100_050)), 1);
    // A window never seen still treats rows already stamped with this second as seen.
    assert.equal(seenBaseline(100_050), 101);
    assert.equal(unreadCount(w, [late], () => read, seenBaseline(100_050)), 0);
    assert.equal(unreadCount(w, [obs(ref("a"), "next", 101)], () => read, seenBaseline(100_050)), 1);
  });

  it("stores last-seen times for the View's windows only", () => {
    assert.deepEqual({ ...parseSeen(JSON.stringify({ w: 5, gone: 9, x: "1", y: -1 }), ["w", "x", "y"]) }, { w: 5 });
    assert.deepEqual({ ...parseSeen("not json", ["w"]) }, {});
    assert.deepEqual({ ...parseSeen(JSON.stringify({ constructor: 1 }), ["constructor"]) }, { constructor: 1 });
    assert.deepEqual({ ...parseSeen(null, ["w"]) }, {});
    assert.deepEqual({ ...markSeen({ w: 50 }, ["w", "v"], 40) }, { w: 50, v: 40 });
  });

  it("treats __proto__ as an ordinary window id", () => {
    const seen = markSeen(parseSeen(null, ["__proto__"]), ["__proto__"], 7);
    assert.ok(Object.hasOwn(seen, "__proto__"));
    assert.equal(seen["__proto__"], 7);
    assert.ok(Object.hasOwn(parseSeen(JSON.stringify(seen), ["__proto__"]), "__proto__"));
  });

  it("merges another tab's times without moving any back", () => {
    assert.deepEqual({ ...mergeSeen({ a: 200, b: 100 }, { a: 100, b: 150, c: 5 }) }, { a: 200, b: 150, c: 5 });
  });
});

describe("focus keys", () => {
  const k = (over: Partial<KeyInput>): KeyInput => ({ key: "", code: "", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, editable: false, ...over });
  const order = ["a", "b", "c"];

  it("maximizes and restores the focused window with F and Esc", () => {
    assert.deepEqual(keyAction(k({ key: "f" }), order, "b", null), { type: "maximize", windowId: "b" });
    assert.deepEqual(keyAction(k({ key: "F" }), order, "b", "b"), { type: "restore" });
    assert.deepEqual(keyAction(k({ key: "Escape" }), order, "b", "b"), { type: "restore" });
    assert.equal(keyAction(k({ key: "Escape" }), order, "b", null), null);
    assert.equal(keyAction(k({ key: "f", editable: true }), order, "b", null), null);
    assert.equal(keyAction(k({ key: "f", ctrlKey: true }), order, "b", null), null);
    assert.equal(keyAction(k({ key: "f" }), order, null, null), null);
  });

  it("moves focus with Alt+1..9", () => {
    assert.deepEqual(keyAction(k({ key: "¡", code: "Digit1", altKey: true }), order, null, null), { type: "focus", windowId: "a" });
    assert.deepEqual(keyAction(k({ code: "Digit3", altKey: true, editable: true }), order, "a", null), { type: "focus", windowId: "c" });
    assert.equal(keyAction(k({ code: "Digit4", altKey: true }), order, null, null), null);
    assert.equal(keyAction(k({ code: "Digit1" }), order, null, null), null);
  });
});

describe("picker edits", () => {
  const ME = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const NET = `s3rch:https://s3r.ch:443;key=${"a".repeat(64)}`;
  const ref = (source: string): SourceRef => ({ network: NET, owner: ME, source, kind: "chat", v: 1 });

  it("lists sources added to new or existing windows", () => {
    const before: View = { id: "v", title: "V", windows: [{ id: "w", kind: "chat", mode: "single", sources: [ref("a")] }], layout: leaf("w"), v: 1 };
    const after: View = {
      ...before,
      windows: [
        { id: "w", kind: "chat", mode: "tabs", sources: [ref("a"), ref("b")] },
        { id: "n", kind: "chat", mode: "single", sources: [ref("c")] },
      ],
    };
    assert.deepEqual(addedSources(before, after).map((r) => r.source), ["b", "c"]);
  });

  it("settles pending marks once a source can be read", () => {
    const view: View = { id: "v", title: "V", windows: [{ id: "w", kind: "chat", mode: "single", sources: [ref("a")], pending: [formatCanonical(ref("a"))] }], layout: leaf("w"), v: 1 };
    assert.equal(settleView(view, () => ({ kind: "on-open" })), null);
    assert.deepEqual(settleView(view, () => ({ kind: "read", post: false }))?.windows[0]!.pending, undefined);
  });
});

describe("checked edits", () => {
  const view: View = { id: "v1", title: "Dev", windows: [], layout: null, v: 1 };
  const rename = (title: string) => (v: View): View => ({ ...v, title });
  const start = saveView(emptyState("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "d1"), view).state;

  it("lets this tab's queued edits follow each other and refuses another tab's", () => {
    let known = openView(start, "v1")!.view;
    const one = editView(start, "v1", known, rename("a"), true);
    known = openView(one.state, "v1")!.view;
    const two = editView(one.state, "v1", known, rename("b"), true);
    assert.equal(openView(two.state, "v1")!.view.title, "b");
    // Another tab saved "c"; this tab still knows "b".
    const other = saveView(two.state, { ...view, title: "c" }).state;
    assert.throws(() => editView(other, "v1", openView(two.state, "v1")!.view, rename("d"), true), /another tab/);
    assert.equal(openView(editView(other, "v1", null, rename("d"), false).state, "v1")!.view.title, "d");
  });

  it("accepts edits after a conflict is resolved to another copy", () => {
    const entry = mergeVersion(start.views["v1"], { id: "v1", vv: { d2: 1 }, view: { ...view, title: "theirs" } });
    const conflicted = { ...start, views: { ...start.views, v1: entry } };
    const theirs = [entry.current, ...entry.conflicts].find((v) => v.view?.title === "theirs")!;
    const resolved = resolveConflict(conflicted, "v1", theirs);
    const known = openView(resolved, "v1")!.view;
    assert.equal(openView(editView(resolved, "v1", known, rename("next"), true).state, "v1")!.view.title, "next");
  });
});

describe("layout saves", () => {
  const step = (tree: LayoutTree) => resizeSplit(tree, [], 0, 0.05);

  it("does not publish an intermediate layout or resize the next step from it", async () => {
    const queue = createLayoutSaveQueue<LayoutTree>();
    let layout: LayoutTree = TREE;
    let layoutRef: LayoutTree = layout;
    let pending = 0;
    let submitted: LayoutTree | null = null;
    const writes: LayoutTree[] = [];
    const published: LayoutTree[] = [];
    let releaseFirst: () => void = () => {};

    const adopt = (incoming: LayoutTree) => {
      if (!shouldAdoptSavedLayout(pending, incoming, submitted)) return;
      layout = incoming;
      layoutRef = incoming;
    };
    const write = (next: LayoutTree) => {
      writes.push(next);
      if (writes.length === 1) return new Promise<LayoutTree>((resolve) => { releaseFirst = () => resolve(next); });
      return Promise.resolve(next);
    };
    const press = () => {
      const next = step(layoutRef);
      layout = next;
      layoutRef = next;
      submitted = next;
      pending += 1;
      const queued = queue.push(next);
      const tracked = queued.done.then(
        () => { pending = Math.max(0, pending - 1); },
        () => { pending = 0; submitted = null; },
      );
      if (queued.start) void drainLayoutSaves(queue, next, write, (saved) => { published.push(saved); adopt(saved); });
      return tracked;
    };

    const first = press();
    const second = press();
    const third = press();
    const newest = layoutRef;
    assert.equal(writes.length, 1);
    releaseFirst();
    await Promise.all([first, second, third]);

    assert.equal(writes.length, 2);
    assert.deepEqual(published, [newest]);
    assert.deepEqual(layoutRef, newest);
    assert.equal(shouldAdoptSavedLayout(1, writes[0]!, newest), false);
    const after = step(layoutRef);
    assert.deepEqual(after, step(newest));
    assert.notDeepEqual(after, step(writes[0]!));
  });

  it("adopts a reloaded layout once a failed save has cleared the queue", async () => {
    const queue = createLayoutSaveQueue<LayoutTree>();
    const first = queue.push(TREE);
    const newer = step(TREE);
    const second = queue.push(newer);
    const ignored = second.done.then(() => undefined, () => undefined);
    const rejected = assert.rejects(first.done);
    let published: LayoutTree | null = null;
    await drainLayoutSaves(queue, TREE, async () => null, (saved) => { published = saved; });
    await rejected;
    await ignored;
    assert.equal(published, null);
    assert.equal(shouldAdoptSavedLayout(0, TREE, null), true);

    const again = queue.push(newer);
    assert.equal(again.start, true);
    await drainLayoutSaves(queue, newer, async (layout) => layout, (saved) => { published = saved; });
    await again.done;
    assert.equal(published, newer);
  });

  it("adopts the stored layout of the resize that was submitted", () => {
    const ME = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const NET = `s3rch:https://s3r.ch:443;key=${"a".repeat(64)}`;
    const ref = (source: string): SourceRef => ({ network: NET, owner: ME, source, kind: "chat", v: 1 });
    const win = (id: string): ViewWindow => ({ id, kind: "chat", mode: "single", sources: [ref(id)] });
    const base: LayoutTree = { type: "split", dir: "row", sizes: [0.5, 0.5], children: [{ type: "leaf", windowId: "a" }, { type: "leaf", windowId: "b" }] };
    const submitted = step(base);
    const newer = step(submitted);
    const view: View = { id: "v1", title: "V", windows: [win("a"), win("b")], layout: submitted, v: 1 };
    const stored = saveView(emptyState(ME, "d1"), view).state.views["v1"]!.current.view!.layout;
    assert.equal(shouldAdoptSavedLayout(2, stored, submitted), true);
    assert.equal(shouldAdoptSavedLayout(2, stored, newer), false);
  });
});

describe("open view", () => {
  it("finds the live copy by id", () => {
    const view: View = { id: "v1", title: "Dev", windows: [], layout: null, v: 1 };
    const { state } = saveView(emptyState("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "d1"), view);
    assert.deepEqual(openView(state, "v1"), { view, conflicted: false });
    assert.equal(openView(state, "v2"), null);
  });
});
