import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeItems } from "./merge";
import { normalizeRss3Activities } from "./normalize";
import { parseRssAtom } from "./rss-atom";
import type { RawActivity } from "./rss3";

describe("normalizeRss3Activities", () => {
  it("maps a GI activity into a tagged Gun item", () => {
    const activities: RawActivity[] = [
      {
        id: "0xabc",
        owner: "0xowner",
        from: "0xfrom",
        network: "ethereum",
        platform: "Farcaster",
        tag: "social",
        type: "post",
        timestamp: 1718689727,
        actions: [
          {
            tag: "social",
            type: "post",
            platform: "Farcaster",
            from: "0xfrom",
            metadata: { handle: "alice", body: "hello mesh" },
            related_urls: ["https://warpcast.com/alice/0xabc"],
          },
        ],
      },
    ];

    const items = normalizeRss3Activities(activities, "rss3:gi:test");
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "0xabc");
    assert.equal(items[0].source, "rss3");
    assert.equal(items[0].kind, "social");
    assert.equal(items[0].author, "alice");
    assert.match(items[0].body, /hello mesh/);
    assert.equal(items[0].permalink, "https://warpcast.com/alice/0xabc");
    assert.deepEqual(items[0].tags, ["social", "post", "ethereum", "farcaster"]);
    assert.equal(items[0].provenance, "rss3:gi:test");
  });

  it("returns no rows when GI data is empty", () => {
    assert.deepEqual(normalizeRss3Activities([], "rss3:gi:test"), []);
  });

  it("skips activities without an id or permalink", () => {
    const items = normalizeRss3Activities(
      [{ tag: "social", timestamp: 1, actions: [{ tag: "social" }] }],
      "rss3:gi:test",
    );
    assert.deepEqual(items, []);
  });
});

describe("mergeItems", () => {
  it("dedupes by id and keeps seed provenance", () => {
    const seed = [
      {
        id: "a1",
        source: "rss3" as const,
        kind: "social",
        author: "seed",
        body: "public",
        ts: 2,
        permalink: "https://example.com/a",
        tags: ["social"],
        provenance: "rss3:gi:public",
      },
    ];
    const overlay = [
      {
        id: "a1",
        source: "rss" as const,
        kind: "rss",
        author: "me",
        body: "mine",
        ts: 9,
        permalink: "https://example.com/a",
        tags: ["rss", "user"],
        provenance: "rss:https://me.example/feed.xml",
      },
      {
        id: "b2",
        source: "rss" as const,
        kind: "rss",
        author: "me",
        body: "extra",
        ts: 8,
        permalink: "https://example.com/b",
        tags: ["rss"],
        provenance: "rss:https://me.example/feed.xml",
      },
    ];
    const merged = mergeItems(seed, overlay);
    assert.equal(merged.length, 2);
    assert.equal(merged[1].id, "a1");
    assert.equal(merged[1].provenance, "rss3:gi:public");
    assert.ok(merged[1].tags.includes("rss"));
    assert.equal(merged[0].id, "b2");
  });
});

describe("parseRssAtom", () => {
  it("reads RSS items", () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0"><channel>
        <item>
          <title>Lab note</title>
          <link>https://fyberlabs.com/note</link>
          <guid>https://fyberlabs.com/note</guid>
          <pubDate>Mon, 31 Aug 2026 12:00:00 GMT</pubDate>
        </item>
      </channel></rss>`;
    const parsed = parseRssAtom(xml, "https://fyberlabs.com/feed.xml");
    assert.equal(parsed.source, "rss");
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0].body, "Lab note");
    assert.deepEqual(parsed.items[0].tags, ["rss", "user"]);
    assert.equal(parsed.items[0].provenance, "rss:https://fyberlabs.com/feed.xml");
  });

  it("reads Atom entries", () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>tag:example.com,2026:1</id>
          <title>Atom hello</title>
          <link href="https://example.com/1"/>
          <updated>2026-08-31T12:00:00Z</updated>
          <author><name>Chris</name></author>
        </entry>
      </feed>`;
    const parsed = parseRssAtom(xml, "https://example.com/atom.xml");
    assert.equal(parsed.source, "atom");
    assert.equal(parsed.items[0].author, "Chris");
    assert.equal(parsed.items[0].permalink, "https://example.com/1");
  });
});
