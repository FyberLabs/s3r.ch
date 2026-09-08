import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeNativePost } from "./compose";
import {
  aggregateDiscoverTags,
  discoverCorpus,
  discoverTagCounts,
  formatDiscoverTagQuery,
  parseDiscoverTagQuery,
  shortenOwner,
} from "./feed-discover";
import { rankFeedItems } from "./feed-rank";
import { itemsForTab } from "./feed-tabs";
import type { FeedItem } from "./feed-types";
import {
  composeRoom,
  rankRooms,
  roomsForTab,
  type Room,
} from "./rooms";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const NOW = 1_700_000_000;

function item(
  overrides: Partial<FeedItem> & Pick<FeedItem, "id" | "ts" | "tags">,
): FeedItem {
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

function room(overrides: {
  title: string;
  address?: string;
  tags?: string[];
  nowSeconds?: number;
  entropy: string;
}): Room {
  const built = composeRoom({
    title: overrides.title,
    address: overrides.address ?? ALICE,
    tags: overrides.tags,
    nowSeconds: overrides.nowSeconds ?? NOW,
    entropy: overrides.entropy,
  });
  assert.ok(built);
  return built;
}

describe("discoverCorpus", () => {
  it("merges Public + Network and never sees Mine overlay", () => {
    const publicItem = item({ id: "pub", ts: 20, tags: ["social"] });
    const networkItem = item({ id: "mesh", ts: 30, tags: ["mesh"] });
    const mineOnly = composeNativePost({
      body: "still mine",
      address: ALICE,
      tags: ["secret-mine"],
      nowSeconds: NOW,
      entropy: "mine1",
    });
    assert.ok(mineOnly);

    const shared = room({ title: "shared", tags: ["lab"], entropy: "aa" });
    const mineRoom = room({ title: "unshared", tags: ["private-room"], entropy: "bb" });

    const seed = [publicItem];
    const overlay = [mineOnly];
    const publicRooms = [shared];
    const mineRooms = [mineRoom];

    const meshRooms: Room[] = [];
    const corpus = discoverCorpus({
      publicItems: itemsForTab("public", seed, overlay, [networkItem]),
      publicRooms: roomsForTab("public", publicRooms, mineRooms, meshRooms),
      networkItems: itemsForTab("network", seed, overlay, [networkItem]),
      networkRooms: roomsForTab("network", publicRooms, mineRooms, meshRooms),
    });

    assert.equal(
      corpus.items.some((row) => row.id === publicItem.id),
      true,
    );
    assert.equal(
      corpus.items.some((row) => row.id === mineOnly.id),
      false,
    );
    assert.equal(
      corpus.rooms.some((row) => row.id === shared.id),
      true,
    );
    assert.equal(
      corpus.rooms.some((row) => row.id === mineRoom.id),
      false,
    );

    const tags = aggregateDiscoverTags(corpus.items, corpus.rooms);
    assert.equal(
      tags.some((row) => row.tag === "secret-mine"),
      false,
    );
    assert.equal(
      tags.some((row) => row.tag === "private-room"),
      false,
    );
    assert.equal(
      tags.some((row) => row.tag === "social"),
      true,
    );
    assert.equal(
      tags.some((row) => row.tag === "lab"),
      true,
    );
    // Live Network mesh is a Discover source. Mine overlay is not.
    assert.equal(
      corpus.items.some((row) => row.id === networkItem.id),
      true,
    );
    assert.equal(
      tags.some((row) => row.tag === "mesh"),
      true,
    );
  });

  it("includes Network items/rooms when that corpus is present", () => {
    const publicItem = item({ id: "pub", ts: 10, tags: ["social"] });
    const meshItem = item({ id: "live", ts: 20, tags: ["mesh-live"] });
    const meshRoom = room({
      title: "mesh room",
      tags: ["mesh-live"],
      entropy: "cc",
    });

    const corpus = discoverCorpus({
      publicItems: [publicItem],
      publicRooms: [],
      networkItems: [meshItem],
      networkRooms: [meshRoom],
    });

    assert.equal(corpus.items.some((row) => row.id === meshItem.id), true);
    assert.equal(corpus.rooms.some((row) => row.id === meshRoom.id), true);
    const tags = aggregateDiscoverTags(corpus.items, corpus.rooms);
    assert.equal(
      tags.some((row) => row.tag === "mesh-live"),
      true,
    );
  });

  it("dedupes the same id across Public and Network", () => {
    const first = item({
      id: "same",
      ts: 10,
      tags: ["social"],
      permalink: "https://example.com/a",
    });
    const later = item({
      id: "same",
      ts: 10,
      tags: ["mesh"],
      permalink: "https://example.com/a",
    });
    const corpus = discoverCorpus({
      publicItems: [first],
      publicRooms: [],
      networkItems: [later],
      networkRooms: [],
    });
    assert.equal(corpus.items.length, 1);
    assert.deepEqual(corpus.items[0]?.tags.sort(), ["mesh", "social"]);
  });
});

describe("aggregateDiscoverTags", () => {
  it("counts items and rooms per tag and sorts alphabetically", () => {
    const manyZ = item({ id: "z1", ts: 1, tags: ["zzz", "social"] });
    const oneA = item({ id: "a1", ts: 2, tags: ["aaa"] });
    const shared = room({
      title: "thread",
      tags: ["zzz", "lab"],
      entropy: "dd",
    });

    const tags = aggregateDiscoverTags([manyZ, oneA], [shared]);
    assert.deepEqual(
      tags.map((row) => row.tag),
      ["aaa", "lab", "room", "s3rch", "social", "zzz"],
    );
    assert.deepEqual(
      tags.find((row) => row.tag === "zzz"),
      { tag: "zzz", itemCount: 1, roomCount: 1 },
    );
    assert.deepEqual(
      tags.find((row) => row.tag === "aaa"),
      { tag: "aaa", itemCount: 1, roomCount: 0 },
    );
    assert.deepEqual(
      tags.find((row) => row.tag === "lab"),
      { tag: "lab", itemCount: 0, roomCount: 1 },
    );
    // High inventory does not float above alphabetical order.
    assert.ok(
      tags.findIndex((row) => row.tag === "aaa") <
        tags.findIndex((row) => row.tag === "zzz"),
    );
  });

  it("empty corpus is empty", () => {
    assert.deepEqual(aggregateDiscoverTags([], []), []);
    assert.deepEqual(discoverTagCounts([]), {});
  });
});

describe("Discover uses the same ranker family", () => {
  it("rankFeedItems / rankRooms still tags-first then recency", () => {
    const twoOld = item({ id: "two-old", ts: 10, tags: ["social", "mesh"] });
    const twoNew = item({ id: "two-new", ts: 30, tags: ["social", "mesh"] });
    const one = item({ id: "one", ts: 40, tags: ["social"] });
    const none = item({ id: "none", ts: 50, tags: ["rss"] });
    const ranked = rankFeedItems([none, one, twoOld, twoNew], ["social", "mesh"]);
    assert.deepEqual(
      ranked.map((row) => row.id),
      ["two-new", "two-old", "one"],
    );

    const rooms = [
      room({ title: "none", tags: ["rss"], nowSeconds: 50, entropy: "w" }),
      room({ title: "one", tags: ["social"], nowSeconds: 40, entropy: "x" }),
      room({
        title: "two-old",
        tags: ["social", "mesh"],
        nowSeconds: 10,
        entropy: "y",
      }),
      room({
        title: "two-new",
        tags: ["social", "mesh"],
        nowSeconds: 30,
        entropy: "z",
      }),
    ];
    const rankedRooms = rankRooms(rooms, ["social", "mesh"]);
    assert.deepEqual(
      rankedRooms.map((row) => row.title),
      ["two-new", "two-old", "one"],
    );
  });
});

describe("discover tag query", () => {
  it("parses and formats a comma list", () => {
    assert.deepEqual(parseDiscoverTagQuery(null), []);
    assert.deepEqual(parseDiscoverTagQuery(""), []);
    assert.deepEqual(parseDiscoverTagQuery(" Social, MESH,social "), [
      "social",
      "mesh",
    ]);
    assert.equal(formatDiscoverTagQuery([" Social", "mesh", "social"]), "social,mesh");
    assert.equal(formatDiscoverTagQuery([]), "");
  });
});

describe("shortenOwner", () => {
  it("truncates a checksummed address; leaves short values", () => {
    assert.equal(shortenOwner(ALICE), "0xf39F…2266");
    assert.equal(shortenOwner(BOB), "0x7099…79C8");
    assert.equal(shortenOwner("lab"), "lab");
  });
});
