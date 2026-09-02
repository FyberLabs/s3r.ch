import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeNativePost, admitNativePost, prepareShareIntoMesh } from "./compose";
import { fromGunNode, toGunNode, isFeedSource, FEED_SOURCES, type FeedItem } from "./feed-types";
import {
  admitFeedNode,
  applySeeGrant,
  checkSee,
  itemSoul,
} from "./identity/check";
import { createMemorySeeAcl } from "./identity/see-acl";
import { itemsForTab } from "./feed-tabs";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const NOW = 1_700_000_000;

function seedItem() {
  return {
    id: "rss3:act/1",
    source: "rss3" as const,
    kind: "social",
    author: "alice",
    body: "seed row",
    ts: NOW - 10,
    permalink: "https://example.com/seed",
    tags: ["social", "farcaster"],
    provenance: "rss3:gi:public",
  };
}

function ingestItem() {
  return {
    id: "rss:https://me.example/feed.xml#1",
    source: "rss" as const,
    kind: "rss",
    author: "me",
    body: "overlay pull",
    ts: NOW - 5,
    permalink: "https://me.example/1",
    tags: ["rss", "user"],
    provenance: "rss:https://me.example/feed.xml",
  };
}

describe("FeedSource s3rch", () => {
  it("is a feed source; existing sources still listed", () => {
    assert.equal(isFeedSource("s3rch"), true);
    for (const source of ["rss3", "rss", "atom", "farcaster", "atproto"] as const) {
      assert.equal(isFeedSource(source), true);
      assert.ok(FEED_SOURCES.includes(source));
    }
    assert.equal(isFeedSource("kyc"), false);
  });

  it("toGunNode / fromGunNode round-trip a native post", () => {
    const item = composeNativePost({
      body: "hello mine",
      address: ALICE.toLowerCase(),
      tags: ["Lab", "lab"],
      nowSeconds: NOW,
      entropy: "ab12cd",
    });
    assert.ok(item);
    const node = toGunNode(item);
    assert.equal(node.source, "s3rch");
    assert.equal(node.tags, "lab,user,s3rch");
    const back = fromGunNode(node);
    assert.deepEqual(back, item);
  });
});

describe("composeNativePost", () => {
  it("builds a valid native item", () => {
    const item = composeNativePost({
      body: "  a note  ",
      address: ALICE.toLowerCase(),
      tags: ["mesh"],
      nowSeconds: NOW,
      entropy: "deadbeef",
    });
    assert.ok(item);
    assert.equal(item.source, "s3rch");
    assert.equal(item.kind, "post");
    assert.equal(item.author, ALICE);
    assert.equal(item.body, "a note");
    assert.equal(item.ts, NOW);
    assert.equal(item.permalink, "");
    assert.equal(item.provenance, `s3rch:native:${ALICE}`);
    assert.equal(item.id, `s3rch:post:${ALICE}:${NOW}:deadbeef`);
    assert.deepEqual(item.tags, ["mesh", "user", "s3rch"]);
  });

  it("rejects an empty body", () => {
    assert.equal(
      composeNativePost({ body: "", address: ALICE, entropy: "aa" }),
      null,
    );
    assert.equal(
      composeNativePost({ body: "   ", address: ALICE, entropy: "aa" }),
      null,
    );
  });

  it("rejects a bad address", () => {
    assert.equal(
      composeNativePost({ body: "hi", address: "not-an-address", entropy: "aa" }),
      null,
    );
  });
});

describe("admit before overlay / share", () => {
  it("admitFeedNode is required before overlay register / share put", () => {
    const acl = createMemorySeeAcl();
    const item = composeNativePost({
      body: "hold this",
      address: ALICE,
      nowSeconds: NOW,
      entropy: "cafebabe",
    });
    assert.ok(item);

    const garbage = admitNativePost(acl, { ...item, id: "" }, ALICE);
    assert.deepEqual(garbage, { denied: true });
    assert.equal(acl.hasObject(itemSoul(item.id)), false);

    const registered = admitNativePost(acl, item, ALICE);
    assert.ok(!("denied" in registered));
    assert.equal(registered.object, itemSoul(item.id));
    assert.equal(acl.hasObject(itemSoul(item.id)), true);

    const deniedShare = prepareShareIntoMesh(acl, { ...item, id: "" }, ALICE);
    assert.deepEqual(deniedShare, { denied: true });

    const share = prepareShareIntoMesh(acl, item, ALICE);
    assert.ok(!("denied" in share));
    assert.equal(share.key, item.id.replace(/[.#$[\]]/g, "_"));
    assert.equal(share.node.source, "s3rch");
    assert.equal(share.node.body, item.body);
  });

  it("direct admitFeedNode still gates a native node", () => {
    const acl = createMemorySeeAcl();
    const item = composeNativePost({
      body: "gated",
      address: ALICE,
      nowSeconds: NOW,
      entropy: "00ff",
    });
    assert.ok(item);
    const denied = admitFeedNode(acl, toGunNode({ ...item, id: "" }), ALICE);
    assert.deepEqual(denied, { denied: true });
    const ok = admitFeedNode(acl, toGunNode(item), ALICE);
    assert.deepEqual(ok, { object: itemSoul(item.id) });
  });
});

describe("Public / Mine filters", () => {
  it("Public excludes unshared native posts; Mine includes native + ingest", () => {
    const native = composeNativePost({
      body: "still mine",
      address: ALICE,
      nowSeconds: NOW,
      entropy: "aabbcc",
    });
    assert.ok(native);
    const seed = [seedItem()];
    const overlay = [native, ingestItem()];

    const pub = itemsForTab("public", seed, overlay);
    assert.equal(pub.some((row) => row.id === native.id), false);
    assert.equal(pub.some((row) => row.id === seed[0].id), true);

    const mine = itemsForTab("mine", seed, overlay);
    assert.equal(mine.some((row) => row.id === native.id), true);
    assert.equal(mine.some((row) => row.id === ingestItem().id), true);
    assert.equal(mine.some((row) => row.id === seed[0].id), false);

    const afterShare = itemsForTab("public", [...seed, native], overlay);
    assert.equal(afterShare.some((row) => row.id === native.id), true);
  });
});

describe("Check see on a native post", () => {
  it("owner vs grant vs missing on a post object", () => {
    const acl = createMemorySeeAcl();
    const item = composeNativePost({
      body: "granted later",
      address: ALICE,
      nowSeconds: NOW,
      entropy: "11",
    });
    assert.ok(item);
    assert.deepEqual(admitNativePost(acl, item, ALICE), {
      item,
      object: itemSoul(item.id),
    });
    const object = itemSoul(item.id);
    assert.equal(checkSee(acl, object, ALICE, NOW).allowed, true);
    assert.equal(checkSee(acl, object, ALICE, NOW).reason, "owner");
    const missing = checkSee(acl, object, BOB, NOW);
    assert.equal(missing.allowed, false);
    assert.equal(missing.reason, "missing-grant");

    applySeeGrant(acl, ALICE, {
      claimId: item.id,
      accessor: BOB,
      from: NOW,
      until: NOW + 60,
    });
    const granted = checkSee(acl, object, BOB, NOW);
    assert.equal(granted.allowed, true);
    assert.equal(granted.reason, "see-grant");
  });

  it("applySeeGrant on a post is not a public share", () => {
    const acl = createMemorySeeAcl();
    const item = composeNativePost({
      body: "grant ≠ publish",
      address: ALICE,
      nowSeconds: NOW,
      entropy: "22",
    });
    assert.ok(item);
    admitNativePost(acl, item, ALICE);
    applySeeGrant(acl, ALICE, {
      claimId: item.id,
      accessor: BOB,
      from: 0,
      until: NOW + 1,
    });

    const seed: FeedItem[] = [];
    const overlay = [item];
    assert.equal(itemsForTab("public", seed, overlay).length, 0);
    assert.equal(itemsForTab("mine", seed, overlay)[0]?.id, item.id);
    assert.equal(checkSee(acl, itemSoul(item.id), BOB, NOW).allowed, true);

    const share = prepareShareIntoMesh(acl, item, ALICE);
    assert.ok(!("denied" in share));
    seed.push(item);
    assert.equal(itemsForTab("public", seed, overlay)[0]?.id, item.id);
  });
});
