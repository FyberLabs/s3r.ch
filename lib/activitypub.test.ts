import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activityPubPermalink,
  collectOutboxItems,
  normalizeActivityPubItem,
  resolvePublicActivityUrl,
} from "./activitypub";
import { fromGunNode, toGunNode } from "./feed-types";

const PROVENANCE = "activitypub:https://mastodon.social/users/Mastodon/outbox";

const NOTE = {
  type: "Note",
  id: "https://mastodon.social/users/Mastodon/statuses/123",
  attributedTo: "https://mastodon.social/users/Mastodon",
  content: "<p>Hello <a href=\"https://example.com\">mesh</a></p>",
  published: "2026-09-01T12:00:00Z",
  url: "https://mastodon.social/@Mastodon/123",
};

describe("normalizeActivityPubItem", () => {
  it("maps an embedded Create/Note into a tagged Gun item", () => {
    const item = normalizeActivityPubItem(
      { type: "Create", object: NOTE },
      PROVENANCE,
      "Mastodon",
    );
    assert.ok(item);
    assert.equal(item.source, "activitypub");
    assert.equal(item.kind, "social");
    assert.equal(item.author, "Mastodon");
    assert.equal(item.body, "Hello mesh");
    assert.equal(item.ts, Math.floor(Date.parse("2026-09-01T12:00:00Z") / 1000));
    assert.equal(item.permalink, "https://mastodon.social/@Mastodon/123");
    assert.deepEqual(item.tags, ["activitypub", "social"]);
    assert.equal(item.provenance, PROVENANCE);
  });

  it("maps a bare Note and falls back to attributedTo leaf", () => {
    const item = normalizeActivityPubItem(NOTE, PROVENANCE);
    assert.equal(item?.author, "Mastodon");
    assert.equal(item?.id, NOTE.id);
  });

  it("skips string IDs, Announce, and missing ids — does not invent rows", () => {
    assert.equal(normalizeActivityPubItem(NOTE.id, PROVENANCE), null);
    assert.equal(
      normalizeActivityPubItem({ type: "Announce", object: NOTE.id }, PROVENANCE),
      null,
    );
    assert.equal(
      normalizeActivityPubItem({ type: "Create", object: NOTE.id }, PROVENANCE),
      null,
    );
    assert.equal(
      normalizeActivityPubItem({ type: "Note", content: "no id" }, PROVENANCE),
      null,
    );
    assert.equal(normalizeActivityPubItem({}, PROVENANCE), null);
  });

  it("survives a Gun round-trip", () => {
    const item = normalizeActivityPubItem(
      { type: "Create", object: NOTE },
      PROVENANCE,
      "Mastodon",
    );
    assert.ok(item);
    assert.deepEqual(fromGunNode(toGunNode(item)), { ...item, v: 1 });
  });
});

describe("collectOutboxItems", () => {
  it("reads orderedItems and skips string IDs", () => {
    const items = collectOutboxItems(
      {
        type: "OrderedCollectionPage",
        orderedItems: [
          { type: "Create", object: NOTE },
          "https://mastodon.social/users/Mastodon/statuses/999",
          { type: "Announce", object: "https://other.example/1" },
        ],
      },
      PROVENANCE,
      "Mastodon",
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, NOTE.id);
  });

  it("returns no rows for an empty collection", () => {
    assert.deepEqual(
      collectOutboxItems({ type: "OrderedCollection", totalItems: 0 }, PROVENANCE),
      [],
    );
  });
});

describe("resolvePublicActivityUrl", () => {
  it("accepts public https and rejects localhost / metadata", () => {
    assert.equal(
      resolvePublicActivityUrl(
        "https://w3c.social/users/w3c/outbox",
        "https://w3c.social/users/w3c",
      ),
      "https://w3c.social/users/w3c/outbox",
    );
    assert.equal(
      resolvePublicActivityUrl("/users/w3c/outbox?page=true", "https://w3c.social/users/w3c"),
      "https://w3c.social/users/w3c/outbox?page=true",
    );
    assert.equal(
      resolvePublicActivityUrl("http://127.0.0.1/outbox", "https://w3c.social/users/w3c"),
      null,
    );
    assert.equal(
      resolvePublicActivityUrl("http://localhost/outbox", "https://w3c.social/users/w3c"),
      null,
    );
  });
});

describe("activityPubPermalink", () => {
  it("prefers url, then Link href, then http(s) id", () => {
    assert.equal(activityPubPermalink("https://a.example/p/1", "https://id"), "https://a.example/p/1");
    assert.equal(
      activityPubPermalink({ href: "https://a.example/p/2" }, "https://id"),
      "https://a.example/p/2",
    );
    assert.equal(activityPubPermalink(undefined, "https://id.example/n"), "https://id.example/n");
    assert.equal(activityPubPermalink(undefined, "tag:example.com,2026:1"), "");
  });
});
