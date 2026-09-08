import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALLOWED_SOURCE_CLASSES,
  admitPulledItems,
  isAllowedSourceClass,
  parseIngestRequest,
  prepareSharePulledIntoMesh,
  pulledItemHasProtocolV1,
} from "./browser-pull";
import { composeNativePost, prepareShareIntoMesh } from "./compose";
import { GUN_PROTOCOL_V, fromGunNode, toGunNode, type FeedItem } from "./feed-types";
import { itemsForTab } from "./feed-tabs";
import { isGrantDeliverableItem } from "./grant-delivery";
import {
  checkSee,
  itemSoul,
} from "./identity/check";
import { createMemorySeeAcl } from "./identity/see-acl";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const NOW = 1_700_000_000;

function farcasterItem(partial: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "0x532064659e980a9a4c3614f2b1deb3ac63e8cc9a",
    source: "farcaster",
    kind: "social",
    author: "v",
    body: "hub cast",
    ts: NOW,
    permalink: "https://farcaster.xyz/v/0x532064659e980a9a4c3614f2b1deb3ac63e8cc9a",
    tags: ["farcaster", "social"],
    provenance: "farcaster:hub:https://hub.pinata.cloud/v1/castsByFid?fid=2",
    ...partial,
  };
}

describe("allowed source classes", () => {
  it("is the documented seeder set, not invented GI or search routes", () => {
    assert.deepEqual([...ALLOWED_SOURCE_CLASSES], [
      "farcaster",
      "atproto",
      "rss",
      "rss3-gi",
    ]);
    assert.equal(isAllowedSourceClass("farcaster"), true);
    assert.equal(isAllowedSourceClass("neynar"), false);
    assert.equal(isAllowedSourceClass("search"), false);
    assert.equal(isAllowedSourceClass(""), false);
  });
});

describe("parseIngestRequest", () => {
  it("accepts one of rssUrl, rss3Account, or allowedSource", () => {
    assert.deepEqual(parseIngestRequest({ rssUrl: " https://blog.ethereum.org/en/feed.xml " }), {
      kind: "rssUrl",
      rssUrl: "https://blog.ethereum.org/en/feed.xml",
    });
    assert.deepEqual(parseIngestRequest({ rss3Account: " vitalik.eth " }), {
      kind: "rss3Account",
      rss3Account: "vitalik.eth",
    });
    assert.deepEqual(parseIngestRequest({ allowedSource: "farcaster" }), {
      kind: "allowedSource",
      allowedSource: "farcaster",
    });
  });

  it("rejects mixed fields, unknown classes, and empty bodies", () => {
    assert.equal(
      parseIngestRequest({ rssUrl: "https://a.test/feed.xml", allowedSource: "farcaster" }).kind,
      "invalid",
    );
    assert.equal(parseIngestRequest({ allowedSource: "neynar" }).kind, "invalid");
    assert.equal(parseIngestRequest({}).kind, "invalid");
    assert.equal(parseIngestRequest(null).kind, "invalid");
  });
});

describe("admitPulledItems", () => {
  it("writes GunFeedNode v:1 and drops empty / unknown-v rows", () => {
    const acl = createMemorySeeAcl();
    const ok = farcasterItem();
    const blank = farcasterItem({ id: "   " });
    const future = farcasterItem({
      id: "0xdead",
      v: 2,
    });
    const admitted = admitPulledItems(acl, [ok, blank, future], ALICE);
    assert.equal(admitted.length, 1);
    assert.equal(admitted[0]?.v, GUN_PROTOCOL_V);
    assert.equal(pulledItemHasProtocolV1(admitted[0]!), true);
    assert.deepEqual(fromGunNode(toGunNode(admitted[0]!)), admitted[0]);
    assert.equal(acl.hasObject(itemSoul(ok.id)), true);
    assert.equal(acl.hasObject(itemSoul("0xdead")), false);
  });

  it("empty or failed sources write nothing", () => {
    const acl = createMemorySeeAcl();
    assert.deepEqual(admitPulledItems(acl, [], ALICE), []);
    assert.deepEqual(
      admitPulledItems(acl, [farcasterItem({ id: "" })], ALICE),
      [],
    );
  });

  it("a URL handoff is not a see-grant for another accessor", () => {
    const acl = createMemorySeeAcl();
    const item = farcasterItem();
    admitPulledItems(acl, [item], ALICE);
    assert.equal(checkSee(acl, itemSoul(item.id), ALICE, NOW).allowed, true);
    assert.equal(checkSee(acl, itemSoul(item.id), BOB, NOW).allowed, false);
    assert.equal(
      checkSee(acl, itemSoul(item.id), BOB, NOW, {
        principal: ALICE,
        target: itemSoul(item.id),
        verb: "ingest",
        context: item.provenance,
      }).allowed,
      false,
    );
  });
});

describe("Mine until explicit share-into-mesh", () => {
  it("admitted pulls stay on Mine; public/network stay empty until share", () => {
    const acl = createMemorySeeAcl();
    const pulled = admitPulledItems(acl, [farcasterItem()], ALICE);
    const overlay = pulled;
    assert.equal(itemsForTab("mine", [], overlay)[0]?.id, pulled[0]?.id);
    assert.equal(itemsForTab("public", [], overlay).length, 0);
    assert.equal(itemsForTab("network", [], overlay, []).length, 0);
    assert.equal(itemsForTab("granted", [], overlay, [], []).length, 0);
  });

  it("prepareSharePulledIntoMesh admits again and is not native share", () => {
    const acl = createMemorySeeAcl();
    const item = farcasterItem();
    const denied = prepareSharePulledIntoMesh(acl, { ...item, id: "" }, ALICE);
    assert.deepEqual(denied, { denied: true });

    const shared = prepareSharePulledIntoMesh(acl, item, ALICE);
    assert.equal("denied" in shared, false);
    if ("denied" in shared) return;
    assert.equal(shared.node.v, GUN_PROTOCOL_V);
    assert.equal(shared.node.unshared, null);
    assert.equal(shared.node.source, "farcaster");
    assert.ok(shared.key);

    const native = composeNativePost({
      body: "mine post",
      address: ALICE,
      nowSeconds: NOW,
      entropy: "aa",
    });
    assert.ok(native);
    assert.deepEqual(prepareSharePulledIntoMesh(acl, native, ALICE), {
      denied: true,
    });
    const nativeShare = prepareShareIntoMesh(acl, native, ALICE);
    assert.equal("denied" in nativeShare, false);
  });

  it("pulled public-source items are not grant-deliverable", () => {
    const item = farcasterItem();
    assert.equal(isGrantDeliverableItem(item), false);
    assert.equal(isGrantDeliverableItem({ ...item, v: 1 }), false);
  });
});
