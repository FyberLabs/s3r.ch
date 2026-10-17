import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccessState } from "./views-access";
import type { ObservedRow } from "./views-decorators";
import { addedSources, keyAction, leafOrder, markSeen, MIN_SPLIT_SIZE, minShare, openView, parseSeen, resizeSplit, settleView, unreadCount, type KeyInput } from "./views-layout";
import { formatCanonical, type SourceRef } from "./views-source-ref";
import { emptyState, saveView } from "./views-store";
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

  it("stores last-seen times for the View's windows only", () => {
    assert.deepEqual(parseSeen(JSON.stringify({ w: 5, gone: 9, x: "1", y: -1 }), ["w", "x", "y"]), { w: 5 });
    assert.deepEqual(parseSeen("not json", ["w"]), {});
    assert.deepEqual(parseSeen(JSON.stringify({ constructor: 1 }), ["constructor"]), { constructor: 1 });
    assert.deepEqual(parseSeen(null, ["w"]), {});
    assert.deepEqual(markSeen({ w: 50 }, ["w", "v"], 40), { w: 50, v: 40 });
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

describe("open view", () => {
  it("finds the live copy by id", () => {
    const view: View = { id: "v1", title: "Dev", windows: [], layout: null, v: 1 };
    const { state } = saveView(emptyState("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "d1"), view);
    assert.deepEqual(openView(state, "v1"), { view, conflicted: false });
    assert.equal(openView(state, "v2"), null);
  });
});
