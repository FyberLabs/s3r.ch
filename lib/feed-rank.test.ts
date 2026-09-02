import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeNativePost } from "./compose";
import { rankFeedItems } from "./feed-rank";
import type { FeedItem } from "./feed-types";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function item(overrides: Partial<FeedItem> & Pick<FeedItem, "id" | "ts" | "tags">): FeedItem {
  return {
    source: "rss3",
    kind: "social",
    author: "seed",
    body: overrides.id,
    permalink: "",
    provenance: "rss3:gi",
    ...overrides,
  };
}

describe("rankFeedItems", () => {
  it("empty tags = recency only", () => {
    const older = item({ id: "old", ts: 10, tags: ["social"] });
    const newer = item({ id: "new", ts: 20, tags: ["mesh"] });
    const ranked = rankFeedItems([older, newer], []);
    assert.deepEqual(
      ranked.map((row) => row.id),
      ["new", "old"],
    );
  });

  it("selected tags prefer more matches, then newer", () => {
    const twoOld = item({ id: "two-old", ts: 10, tags: ["social", "mesh"] });
    const twoNew = item({ id: "two-new", ts: 30, tags: ["social", "mesh"] });
    const one = item({ id: "one", ts: 40, tags: ["social"] });
    const none = item({ id: "none", ts: 50, tags: ["rss"] });
    const ranked = rankFeedItems([none, one, twoOld, twoNew], ["social", "mesh"]);
    assert.deepEqual(
      ranked.map((row) => row.id),
      ["two-new", "two-old", "one"],
    );
  });

  it("native + seed items share the ranker", () => {
    const seed = item({
      id: "seed-social",
      ts: 100,
      tags: ["social", "farcaster"],
      source: "farcaster",
    });
    const native = composeNativePost({
      body: "lab note",
      address: ALICE,
      tags: ["social", "lab"],
      nowSeconds: 90,
      entropy: "rank",
    });
    assert.ok(native);
    const ranked = rankFeedItems([seed, native], ["social", "lab"]);
    assert.equal(ranked[0]?.id, native.id);
    assert.equal(ranked[1]?.id, seed.id);
    const recency = rankFeedItems([seed, native], []);
    assert.equal(recency[0]?.id, seed.id);
    assert.equal(recency[1]?.id, native.id);
  });
});
