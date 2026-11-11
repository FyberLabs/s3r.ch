import assert from "node:assert/strict";
import test from "node:test";
import type { FeedItem, SourcePull } from "./feed-types";
import { collectSourceWindows, reconcileSourceWindows, type SourceCache } from "./source-windows";
import { combinePulls } from "./seed";
import { parseRssAtom } from "./rss-atom";

const item = (id: string, source: FeedItem["source"] = "rss"): FeedItem => ({
  id, source, kind: "post", author: "author", body: `body-${id}`, ts: 1,
  permalink: `https://example.org/${id}`, tags: [], provenance: "rss:fixture",
});
const empty = (): SourceCache => ({ items: new Map(), windows: new Map(), retired: new Set() });
const pull = (windows: [string, FeedItem[]][], completeSources: SourcePull["completeSources"] = []): SourcePull => ({
  windows: windows.map(([key, items]) => ({ key, items })), items: windows.flatMap(([, items]) => items),
  completeSources, sourcesOk: windows.length, sourcesTried: 2, error: null,
});

test("completed windows replace, failed windows preserve, and empty success removes", async () => {
  const before = reconcileSourceWindows(empty(), pull([["a", [item("old")]], ["b", [item("keep")]]]));
  const mixed = await collectSourceWindows([
    { key: "a", pull: async () => [item("new")] },
    { key: "b", pull: async () => { throw Error("offline"); } },
  ], ["rss"], "rss unavailable");
  assert.equal(mixed.sourcesOk, 1);
  assert.deepEqual(mixed.completeSources, []);
  const after = reconcileSourceWindows(before, mixed);
  assert.deepEqual([...after.items.keys()].sort(), ["keep", "new"]);
  assert.deepEqual([...after.retired], ["old"]);
  assert.deepEqual([...before.items.keys()], ["old", "keep"], "input is immutable");
  const cleared = reconcileSourceWindows(after, pull([["a", []]]));
  assert.deepEqual([...cleared.items.keys()], ["keep"]);
});

test("duplicate rows remain until their last successful source window drops them", () => {
  const before = reconcileSourceWindows(empty(), pull([["a", [item("same")]], ["b", [item("same")]]]));
  const one = reconcileSourceWindows(before, pull([["a", []]]));
  assert.ok(one.items.has("same"));
  assert.equal(one.retired.size, 0);
  const neither = reconcileSourceWindows(one, pull([["b", []]]));
  assert.equal(neither.items.size, 0);
  assert.ok(neither.retired.has("same"));
  const returned = reconcileSourceWindows(neither, pull([["a", [item("same")]]]));
  assert.ok(returned.items.has("same"));
  assert.equal(returned.retired.size, 0);
});

test("legacy snapshots converge on complete class success without deleting native or failed classes", () => {
  const before = empty();
  for (const row of [item("old"), item("ap", "activitypub"), item("native", "s3rch")]) before.items.set(row.id, row);
  const partial = reconcileSourceWindows(before, pull([["rss", [item("new")]]]));
  assert.ok(partial.items.has("old"));
  const complete = reconcileSourceWindows(partial, pull([["rss", [item("new")]]], ["rss", "atom"]));
  assert.deepEqual([...complete.items.keys()].sort(), ["ap", "native", "new"]);
});

test("all-failed pulls preserve content; aggregation preserves empty window ownership", async () => {
  const failed = await collectSourceWindows([{ key: "x", pull: async () => { throw Error("offline"); } }], ["rss"], "rss down");
  assert.equal(failed.sourcesOk, 0);
  assert.deepEqual(failed.windows, []);
  assert.match(failed.error!, /offline/);
  const success = await collectSourceWindows([{ key: "empty", pull: async () => [] }], ["atom"], "atom down");
  const combined = combinePulls([failed, success]);
  assert.deepEqual(combined.windows, [{ key: "empty", items: [] }]);
  assert.deepEqual(combined.completeSources, ["atom"]);
});

test("empty RSS/Atom is a window; non-feed and truncated payloads are not", () => {
  assert.deepEqual(parseRssAtom('<feed xmlns="http://www.w3.org/2005/Atom"/>', "https://example.org/atom"), { source: "atom", items: [] });
  assert.deepEqual(parseRssAtom("<rss><channel></channel></rss>", "https://example.org/rss"), { source: "rss", items: [] });
  for (const body of ["<html>rate limited</html>", "<rss><channel>", "<feed><entry>", "<rss><channel><item>broken</channel></rss>"]) {
    assert.throws(() => parseRssAtom(body, "https://example.org/rss"));
  }
});


test("overlapping source IDs preserve first-source precedence", () => {
  const after = reconcileSourceWindows(empty(), pull([
    ["first", [item("same")]], ["second", [{ ...item("same"), body: "other source" }]],
  ]));
  assert.equal(after.items.get("same")?.body, "body-same");
  assert.deepEqual(after.windows.get("second"), ["same"]);
});
