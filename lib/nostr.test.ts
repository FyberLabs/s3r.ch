import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromGunNode, toGunNode } from "./feed-types";
import {
  kind1Filter,
  normalizeNostrEvent,
  nostrPermalink,
  nostrProvenance,
  parseNostrFrame,
} from "./nostr";

const PUBKEY = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
const EVENT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROVENANCE = nostrProvenance("wss://nos.lol", PUBKEY);

const KIND1 = {
  id: EVENT_ID,
  pubkey: PUBKEY,
  created_at: 1_725_276_800,
  kind: 1,
  tags: [],
  content: "hello nostr",
  sig: "bb",
};

describe("normalizeNostrEvent", () => {
  it("maps a kind 1 note into a tagged Gun item", () => {
    const item = normalizeNostrEvent(KIND1, PROVENANCE);
    assert.ok(item);
    assert.equal(item.source, "nostr");
    assert.equal(item.kind, "social");
    assert.equal(item.id, EVENT_ID);
    assert.equal(item.author, PUBKEY);
    assert.equal(item.body, "hello nostr");
    assert.equal(item.ts, 1_725_276_800);
    assert.equal(item.permalink, `https://njump.me/${EVENT_ID}`);
    assert.deepEqual(item.tags, ["nostr", "social"]);
    assert.match(item.provenance, /^nostr:relay:wss:\/\/nos\.lol/);
    assert.match(item.provenance, /kinds=1/);
    assert.match(item.provenance, new RegExp(`authors=${PUBKEY}`));
  });

  it("skips other kinds, missing ids, and junk — does not invent rows", () => {
    assert.equal(normalizeNostrEvent({ ...KIND1, kind: 0 }, PROVENANCE), null);
    assert.equal(normalizeNostrEvent({ ...KIND1, kind: 7 }, PROVENANCE), null);
    assert.equal(normalizeNostrEvent({ ...KIND1, id: "short" }, PROVENANCE), null);
    assert.equal(normalizeNostrEvent({ kind: 1, content: "no id" }, PROVENANCE), null);
    assert.equal(normalizeNostrEvent({}, PROVENANCE), null);
  });

  it("survives a Gun round-trip", () => {
    const item = normalizeNostrEvent(KIND1, PROVENANCE);
    assert.ok(item);
    assert.deepEqual(fromGunNode(toGunNode(item)), { ...item, v: 1 });
  });
});

describe("parseNostrFrame", () => {
  it("reads EVENT and EOSE for our subscription", () => {
    assert.deepEqual(parseNostrFrame(["EVENT", "sub1", KIND1], "sub1"), {
      kind: "event",
      event: KIND1,
    });
    assert.deepEqual(parseNostrFrame(["EOSE", "sub1"], "sub1"), { kind: "eose" });
    assert.equal(parseNostrFrame(["EVENT", "other", KIND1], "sub1"), null);
    assert.equal(parseNostrFrame(["NOTICE", "hi"], "sub1"), null);
    assert.equal(parseNostrFrame("EVENT", "sub1"), null);
  });
});

describe("kind1Filter / permalink", () => {
  it("is a documented kind 1 authors query", () => {
    assert.deepEqual(kind1Filter(PUBKEY, 20), {
      authors: [PUBKEY],
      kinds: [1],
      limit: 20,
    });
    assert.equal(nostrPermalink(EVENT_ID), `https://njump.me/${EVENT_ID}`);
    assert.equal(nostrPermalink("nope"), "");
  });
});
