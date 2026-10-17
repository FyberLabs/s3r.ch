import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyPick,
  buildBrowseTree,
  canMergeFeeds,
  compatibleKinds,
  filterTree,
  inferKind,
  kindsForTarget,
  leavesOf,
  toggleGroup,
  toggleSource,
  triState,
  visibleRows,
  type PickerSource,
} from "./views-picker";
import type { SourceKind } from "./views-source-ref";
import type { View } from "./views-window";

const ME = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ORG = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const NET = `s3rch:https://s3r.ch:443;key=${"a".repeat(64)}`;
const LAB = `s3rch:https://lab.example:443;key=${"b".repeat(64)}`;

function src(source: string, kind: SourceKind = "chat", network = NET, owner = ME): PickerSource {
  return { ref: { network, owner, source, kind, v: 1 }, label: `#${source}` };
}

const build = src("build");
const design = src("design");
const ops = src("ops", "chat", NET, ORG);
const labRoom = src("lab", "chat", LAB);
const news = { ref: { network: "rss", owner: "https://hn.example", source: "https://hn.example/rss", kind: "feed" as const, v: 1 as const }, label: "HN" };
const blog = { ref: { network: "rss", owner: "https://blog.example", source: "https://blog.example/feed", kind: "feed" as const, v: 1 as const }, label: "Blog" };

function emptyView(): View {
  return { id: "v1", title: "Dev", windows: [], layout: null, v: 1 };
}

let n = 0;
const newId = () => `w${++n}`;

describe("browse tree", () => {
  it("groups by network and owner and labels me", () => {
    const tree = buildBrowseTree([ops, build, labRoom, news, design, build], NET, ME);
    assert.deepEqual(tree.map((t) => t.label), ["This network (s3r.ch)", "Other s3r.ch networks", "Protocols"]);
    const self = tree[0]!;
    assert.deepEqual(self.children!.map((c) => c.label), ["0x70…C8", "Me (0xf3…66)"]);
    assert.deepEqual(self.children![1]!.children!.map((c) => c.label), ["#build", "#design"]);
    assert.equal(tree[1]!.children![0]!.label, "lab.example");
    assert.equal(tree[2]!.children![0]!.label, "RSS");
    assert.equal(leavesOf(self).length, 3);
  });

  it("filters leaves and drops empty branches", () => {
    const tree = buildBrowseTree([build, news], NET, ME);
    const feeds = filterTree(tree, (s) => s.ref.kind === "feed");
    assert.deepEqual(feeds.map((t) => t.label), ["Protocols"]);
  });

  it("lists rows of expanded branches only", () => {
    const tree = buildBrowseTree([build, design], NET, ME);
    assert.equal(visibleRows(tree, new Set()).length, 1);
    const rows = visibleRows(tree, new Set(["self", `self/${ME}`]));
    assert.deepEqual(rows.map((r) => [r.node.label, r.depth]), [["This network (s3r.ch)", 0], ["Me (0xf3…66)", 1], ["#build", 2], ["#design", 2]]);
  });
});

describe("selection", () => {
  it("toggles sources and groups with tri-state", () => {
    let sel = toggleSource([], build);
    assert.equal(triState(sel, [build, design]), "mixed");
    sel = toggleGroup(sel, [build, design]);
    assert.equal(triState(sel, [build, design]), "checked");
    assert.deepEqual(sel.map((s) => s.label), ["#build", "#design"]);
    sel = toggleGroup(sel, [build, design]);
    assert.equal(triState(sel, [build, design]), "unchecked");
    assert.deepEqual(toggleSource(toggleSource([], build), build), []);
  });

  it("infers the kind from the first source and limits overrides", () => {
    assert.equal(inferKind([news, build]), "feed");
    assert.equal(inferKind([]), null);
    assert.deepEqual(compatibleKinds([build, design]), ["chat"]);
    assert.deepEqual(compatibleKinds([build, news]), []);
    assert.equal(canMergeFeeds([news, blog]), true);
    assert.equal(canMergeFeeds([news, build]), false);
    assert.equal(canMergeFeeds([news]), false);
  });
});

describe("applyPick", () => {
  it("defaults to one window per source", () => {
    const r = applyPick(emptyView(), { type: "new" }, [build, news], { newId });
    assert.ok(r.ok);
    assert.deepEqual(r.view.windows.map((w) => [w.kind, w.mode, w.sources.length, w.label]), [["chat", "single", 1, "#build"], ["feed", "single", 1, "HN"]]);
    assert.equal(r.view.layout?.type, "split");
  });

  it("merges feeds into one window only when asked and all are feeds", () => {
    const r = applyPick(emptyView(), { type: "new" }, [news, blog], { newId, merge: true });
    assert.ok(r.ok);
    assert.deepEqual(r.view.windows.map((w) => [w.kind, w.mode, w.sources.length]), [["feed", "merged", 2]]);
    assert.equal(applyPick(emptyView(), { type: "new" }, [news, build], { newId, merge: true }).ok, false);
  });

  it("rejects a kind override that does not match", () => {
    const r = applyPick(emptyView(), { type: "new", kind: "feed" }, [build], { newId });
    assert.equal(r.ok, false);
  });

  it("adds to an existing window as tabs and skips duplicates", () => {
    const first = applyPick(emptyView(), { type: "new" }, [build], { newId });
    assert.ok(first.ok);
    const id = first.windowIds[0]!;
    const r = applyPick(first.view, { type: "window", windowId: id }, [build, design], { newId });
    assert.ok(r.ok);
    assert.deepEqual(r.view.windows[0]!.mode, "tabs");
    assert.deepEqual(r.view.windows[0]!.sources.map((s) => s.source), ["build", "design"]);
    assert.equal(applyPick(r.view, { type: "window", windowId: id }, [news], { newId }).ok, false);
    assert.equal(applyPick(r.view, { type: "window", windowId: id }, [build], { newId }).ok, false);
    assert.deepEqual(kindsForTarget(r.view, { type: "window", windowId: id }), ["chat"]);
  });

  it("keeps a merged feed window merged", () => {
    const first = applyPick(emptyView(), { type: "new" }, [news, blog], { newId, merge: true });
    assert.ok(first.ok);
    const third = { ...news, ref: { ...news.ref, owner: "https://c.example", source: "https://c.example/rss" }, label: "C" };
    const r = applyPick(first.view, { type: "window", windowId: first.windowIds[0]! }, [third], { newId });
    assert.ok(r.ok);
    assert.equal(r.view.windows[0]!.mode, "merged");
  });

  it("respects the window limit", () => {
    const many = Array.from({ length: 13 }, (_, i) => src(`r${i}`));
    assert.equal(applyPick(emptyView(), { type: "new" }, many, { newId }).ok, false);
  });

  it("does not reuse an existing window id", () => {
    const first = applyPick(emptyView(), { type: "new" }, [build], { newId: () => "same" });
    assert.ok(first.ok);
    let k = 0;
    const r = applyPick(first.view, { type: "new" }, [design], { newId: () => (k++ === 0 ? "same" : "other") });
    assert.ok(r.ok);
    assert.deepEqual(r.view.windows.map((w) => w.id), ["same", "other"]);
  });
});
