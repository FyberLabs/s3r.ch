import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromGunNode } from "./feed-types";
import type { FeedItem, SourcePull } from "./feed-types";
import { combinePulls } from "./seed";

function item(partial: Partial<FeedItem> & Pick<FeedItem, "id" | "source">): FeedItem {
  return {
    kind: "social",
    author: "x",
    body: "y",
    ts: 1,
    permalink: `https://example.com/${partial.id}`,
    tags: ["social"],
    provenance: `${partial.source}:test`,
    ...partial,
  };
}

describe("combinePulls", () => {
  it("keeps live sources when GI fails", () => {
    const farcaster: SourcePull = {
      items: [item({ id: "0xfc", source: "farcaster", tags: ["farcaster", "social"] })],
      sourcesOk: 3,
      sourcesTried: 3,
      error: null,
    };
    const atproto: SourcePull = {
      items: [item({ id: "at://did:plc:x/app.bsky.feed.post/1", source: "atproto", tags: ["atproto", "bsky"] })],
      sourcesOk: 2,
      sourcesTried: 2,
      error: null,
    };
    const rss: SourcePull = {
      items: [item({ id: "https://blog.ethereum.org/1", source: "rss", tags: ["rss", "ethereum"] })],
      sourcesOk: 1,
      sourcesTried: 2,
      error: null,
    };
    const gi: SourcePull = {
      items: [],
      sourcesOk: 0,
      sourcesTried: 6,
      error: "getaddrinfo ENOTFOUND gi.rss3.io",
    };

    const combined = combinePulls([farcaster, atproto, rss, gi]);
    assert.equal(combined.sourcesOk, 6);
    assert.equal(combined.sourcesTried, 13);
    assert.equal(combined.error, null);
    assert.equal(combined.items.length, 3);
    assert.ok(combined.items.some((row) => row.source === "farcaster"));
    assert.ok(combined.items.some((row) => row.source === "atproto" || row.source === "rss"));
  });

  it("returns no rows and an error when every source fails", () => {
    const combined = combinePulls([
      { items: [], sourcesOk: 0, sourcesTried: 3, error: "hub down" },
      { items: [], sourcesOk: 0, sourcesTried: 2, error: "appview down" },
      { items: [], sourcesOk: 0, sourcesTried: 6, error: "GI DNS" },
    ]);
    assert.equal(combined.sourcesOk, 0);
    assert.deepEqual(combined.items, []);
    assert.equal(combined.error, "hub down");
  });

  it("does not invent rows for empty successful sources", () => {
    const combined = combinePulls([
      { items: [], sourcesOk: 1, sourcesTried: 1, error: null },
    ]);
    assert.equal(combined.sourcesOk, 1);
    assert.deepEqual(combined.items, []);
    assert.equal(combined.error, null);
  });
});

describe("fromGunNode", () => {
  it("drops unknown sources", () => {
    assert.equal(fromGunNode({ id: "x", source: "neynar", kind: "social", tags: "" }), null);
  });
});
