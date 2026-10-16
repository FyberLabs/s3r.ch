import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeedItem } from "./feed-types";
import { chatRow, feedRow, feedSourceRef, forumRow, forumSourceRef, roomSourceRef } from "./views-adapters";
import type { SourceRef } from "./views-source-ref";
import { defaultLayout, layoutWithinBounds, loadView, MAX_WINDOWS, repairLayout, validateWindow } from "./views-window";

const NET = `s3rch:https://s3r.ch:443;key=${"a".repeat(64)}`;
const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function ref(kind: SourceRef["kind"], source: string): SourceRef {
  return { network: NET, owner: ALICE, source, kind, v: 1 };
}

function win(id: string, kind: SourceRef["kind"], mode: "single" | "tabs" | "merged", n: number) {
  return { id, kind, mode, sources: Array.from({ length: n }, (_, i) => ref(kind, `${id}-${i}`)) };
}

describe("window kind and mode", () => {
  it("allows merged only for feed windows", () => {
    assert.equal(validateWindow(win("w", "feed", "merged", 2)).ok, true);
    for (const kind of ["chat", "forum", "stream", "voice"] as const) {
      const r = validateWindow(win("w", kind, "merged", 2));
      assert.equal(r.ok, false, kind);
    }
  });

  it("limits tabs to chat, forum and feed, and stream/voice to single", () => {
    for (const kind of ["chat", "forum", "feed"] as const) assert.equal(validateWindow(win("w", kind, "tabs", 3)).ok, true);
    for (const kind of ["stream", "voice"] as const) {
      assert.equal(validateWindow(win("w", kind, "tabs", 2)).ok, false);
      assert.equal(validateWindow(win("w", kind, "single", 1)).ok, true);
    }
  });

  it("enforces source counts and matching kinds", () => {
    assert.equal(validateWindow(win("w", "chat", "single", 2)).ok, false);
    assert.equal(validateWindow(win("w", "chat", "tabs", 1)).ok, false);
    assert.equal(validateWindow(win("w", "feed", "merged", 9)).ok, false);
    assert.equal(validateWindow(win("w", "feed", "merged", 8)).ok, true);
    const mixed = { ...win("w", "chat", "tabs", 1), sources: [ref("chat", "a"), ref("feed", "b")] };
    assert.equal(validateWindow(mixed).ok, false);
    const dup = { ...win("w", "chat", "tabs", 1), sources: [ref("chat", "a"), ref("chat", "a")] };
    assert.equal(validateWindow(dup).ok, false);
    assert.equal(validateWindow({ ...win("", "chat", "single", 1) }).ok, false);
  });
});

describe("view loading", () => {
  let n = 0;
  const newId = () => `gen-${++n}`;

  it("rejects too many windows before anything else", () => {
    const windows = Array.from({ length: MAX_WINDOWS + 1 }, (_, i) => win(`w${i}`, "chat", "single", 1));
    assert.equal(loadView({ id: "v", title: "t", windows, layout: null, v: 1 }, newId).ok, false);
  });

  it("drops invalid windows with a notice and repairs the layout", () => {
    const layout = {
      type: "split",
      dir: "col",
      sizes: [1, 3],
      children: [
        { type: "leaf", windowId: "bad" },
        { type: "split", dir: "row", sizes: [1, 1], children: [{ type: "leaf", windowId: "a" }, { type: "leaf", windowId: "gone" }] },
      ],
    };
    const r = loadView(
      { id: "v", title: "t", windows: [win("a", "chat", "single", 1), win("bad", "chat", "merged", 2), win("b", "feed", "merged", 2)], layout, v: 1 },
      newId,
    );
    assert.ok(r.ok);
    assert.deepEqual(r.view.windows.map((w) => w.id), ["a", "b"]);
    assert.equal(r.notices.length, 1);
    assert.equal(r.notices[0]?.windowId, "bad");
    assert.deepEqual(r.view.layout, {
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [{ type: "leaf", windowId: "a" }, { type: "leaf", windowId: "b" }],
    });
  });

  it("regenerates duplicate window ids with a notice", () => {
    const r = loadView(
      { id: "v", title: "t", windows: [win("a", "chat", "single", 1), { ...win("a", "feed", "single", 1) }], layout: { type: "leaf", windowId: "a" }, v: 1 },
      newId,
    );
    assert.ok(r.ok);
    const ids = r.view.windows.map((w) => w.id);
    assert.equal(new Set(ids).size, 2);
    assert.equal(ids[0], "a");
    assert.match(r.notices[0]?.message ?? "", /Duplicate/);
    assert.deepEqual(r.view.layout, {
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: ids.map((windowId) => ({ type: "leaf", windowId })),
    });
  });

  it("uses null layout for an empty view", () => {
    const r = loadView({ id: "v", title: "t", windows: [], layout: { type: "leaf", windowId: "x" }, v: 1 }, newId);
    assert.ok(r.ok);
    assert.equal(r.view.layout, null);
  });
});

describe("layout bounds", () => {
  it("rejects deep or large layouts and falls back to the default grid", () => {
    let deep: unknown = { type: "leaf", windowId: "a" };
    for (let i = 0; i < 20; i++) deep = { type: "split", dir: "row", sizes: [1], children: [deep] };
    assert.equal(layoutWithinBounds(deep), false);
    assert.deepEqual(repairLayout(deep, ["a"]), defaultLayout(["a"]));
    const wide = { type: "split", dir: "row", sizes: [], children: Array.from({ length: 100 }, () => ({ type: "leaf", windowId: "a" })) };
    assert.equal(layoutWithinBounds(wide), false);
  });

  it("normalizes huge sizes without overflow", () => {
    const t = { type: "split", dir: "row", sizes: [Number.MAX_VALUE, Number.MAX_VALUE], children: [{ type: "leaf", windowId: "a" }, { type: "leaf", windowId: "b" }] };
    assert.deepEqual((repairLayout(t, ["a", "b"]) as { sizes: number[] }).sizes, [0.5, 0.5]);
  });

  it("keeps sizes positive after appending missing windows", () => {
    const t = { type: "split", dir: "row", sizes: [Number.MIN_VALUE, 1], children: [{ type: "leaf", windowId: "a" }, { type: "leaf", windowId: "b" }] };
    const out = repairLayout(t, ["a", "b", "c", "d"]) as { sizes: number[]; children: unknown[] };
    assert.equal(out.children.length, 4);
    assert.ok(out.sizes.every((s) => s > 0));
    assert.ok(Math.abs(out.sizes.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  });

  it("collapses single-child splits and fixes bad sizes", () => {
    const t = { type: "split", dir: "col", sizes: [-1, Number.NaN], children: [{ type: "leaf", windowId: "a" }, { type: "leaf", windowId: "b" }] };
    assert.deepEqual(repairLayout(t, ["a", "b"]), { type: "split", dir: "col", sizes: [0.5, 0.5], children: t.children });
    assert.deepEqual(repairLayout(t, ["a"]), { type: "leaf", windowId: "a" });
  });
});

describe("adapters", () => {
  it("maps rooms, forums and feeds to rows and rejects mismatched sources", () => {
    const r = roomSourceRef(NET, { id: "r1", owner: ALICE });
    assert.ok(r.ok);
    const row = chatRow(r.value, { id: "m1", room: "r1", author: ALICE, body: "hi", ts: 10 });
    assert.equal(row?.author, ALICE);
    assert.ok(row?.key.endsWith("#m1"));
    assert.equal(chatRow(r.value, { id: "m1", room: "r2", author: ALICE, body: "hi", ts: 10 }), null);

    const f = forumSourceRef(NET, { id: "c1", owner: ALICE });
    assert.ok(f.ok);
    assert.equal(forumRow(f.value, { id: "x", channel: "c1", owner: ALICE, bot: "bot1", body: "b", ts: 1, v: 1 })?.author, "bot1");
    assert.equal(chatRow(f.value, { id: "m", room: "c1", author: ALICE, body: "", ts: 1 }), null);

    const feed = feedSourceRef("farcaster", "3", "casts");
    assert.ok(feed.ok);
    const item: FeedItem = { id: "fc:1", source: "farcaster", kind: "social", author: "dwr", body: "x", ts: 5, permalink: "https://x.test/1", tags: [], provenance: "p" };
    assert.equal(feedRow(feed.value, item)?.permalink, "https://x.test/1");
    assert.equal(feedRow(feed.value, { ...item, ts: Number.NaN }), null);
    assert.equal(roomSourceRef(NET, { id: "r1", owner: "alice" }).ok, false);
    assert.equal(roomSourceRef("farcaster", { id: "r1", owner: "3" }).ok, false);
    assert.equal(forumSourceRef("farcaster", { id: "c1", owner: "3" }).ok, false);
  });
});
