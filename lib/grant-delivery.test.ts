import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitNativePost, composeNativePost } from "./compose";
import {
  acceptGrantDelivery,
  fromGrantDeliveryNode,
  isGrantDeliverableItem,
  isGrantTombstone,
  isPublicGraphSoul,
  prepareGrantItemDelivery,
  prepareGrantRetract,
  prepareGrantRoomDelivery,
  prepareGrantUserDelivery,
} from "./grant-delivery";
import { itemsForTab } from "./feed-tabs";
import type { FeedItem } from "./feed-types";
import {
  applySeeGrant,
  cancelSee,
  checkSee,
  grantedSoul,
  itemSoul,
  roomSoul,
  userSoul,
} from "./identity/check";
import { createMemorySeeAcl } from "./identity/see-acl";
import {
  admitComposedRoom,
  composeRoom,
  roomsForTab,
  type Room,
} from "./rooms";
import { admitComposedUser, composeUser } from "./users";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CAROL = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const NOW = 1_700_000_000;

function nativePost(body = "granted body", entropy = "aa11"): FeedItem {
  const item = composeNativePost({
    body,
    address: ALICE,
    nowSeconds: NOW,
    entropy,
  });
  assert.ok(item);
  return item;
}

function ingestItem(): FeedItem {
  return {
    id: "https://example.test/ingest.xml#1",
    source: "rss",
    kind: "rss",
    author: "me",
    body: "overlay ingest",
    ts: NOW,
    permalink: "https://example.test/ingest.xml",
    tags: ["rss", "user"],
    provenance: "rss:https://example.test/ingest.xml",
  };
}

function mineRoom(title = "granted room", entropy = "bb22"): Room {
  const room = composeRoom({
    title,
    address: ALICE,
    nowSeconds: NOW,
    entropy,
  });
  assert.ok(room);
  return room;
}

function grantFor(claimId: string, accessor = BOB, from = NOW, until = NOW + 60) {
  return { claimId, accessor, from, until };
}

describe("grant-deliverable objects", () => {
  it("native Gun posts are deliverable; URL ingest is a handoff", () => {
    const item = nativePost();
    assert.equal(isGrantDeliverableItem(item), true);
    assert.equal(isGrantDeliverableItem(ingestItem()), false);
    assert.equal(
      isGrantDeliverableItem({
        ...ingestItem(),
        id: "rss:user/1",
      }),
      false,
    );
  });
});

describe("locked grant inbox souls", () => {
  it("lives under s3rch/granted and is not a public graph soul", () => {
    const item = nativePost();
    const soul = grantedSoul(BOB, "items", item.id);
    assert.equal(soul.startsWith(`s3rch/granted/${BOB}/items/`), true);
    assert.equal(isPublicGraphSoul(soul), false);
    assert.equal(isPublicGraphSoul(itemSoul(item.id)), true);
    assert.equal(isPublicGraphSoul(roomSoul("s3rch:room:x")), true);
    assert.equal(isPublicGraphSoul(userSoul(ALICE)), true);
  });
});

describe("prepareGrantItemDelivery", () => {
  it("puts the native post on the accessor inbox only after Check passes", () => {
    const acl = createMemorySeeAcl();
    const item = nativePost();
    admitNativePost(acl, item, ALICE);
    const grant = grantFor(item.id);
    assert.deepEqual(
      prepareGrantItemDelivery(acl, item, ALICE, grant, NOW),
      { denied: true, reason: "check" },
    );

    applySeeGrant(acl, ALICE, grant);
    const prepared = prepareGrantItemDelivery(acl, item, ALICE, grant, NOW);
    assert.ok(!("denied" in prepared));
    assert.equal(prepared.accessorKey, BOB);
    assert.equal(prepared.kindKey, "items");
    assert.equal(prepared.soul, grantedSoul(BOB, "items", item.id));
    assert.equal(isPublicGraphSoul(prepared.soul), false);
    assert.equal("retracted" in prepared.node, false);
    if ("retracted" in prepared.node) return;
    assert.equal(prepared.node.kind, "item");
    assert.equal(prepared.node.v, 1);
    assert.equal(prepared.node.payload.includes(item.body), true);
    assert.equal(prepared.node.payload.includes("priv"), false);
  });

  it("denies URL ingest, missing grant, expired window, and self-grant", () => {
    const acl = createMemorySeeAcl();
    const item = nativePost("later", "cc33");
    admitNativePost(acl, item, ALICE);
    applySeeGrant(acl, ALICE, grantFor(item.id, BOB, NOW, NOW + 10));
    assert.deepEqual(
      prepareGrantItemDelivery(acl, ingestItem(), ALICE, grantFor(ingestItem().id), NOW),
      { denied: true, reason: "not-deliverable" },
    );
    assert.deepEqual(
      prepareGrantItemDelivery(acl, item, ALICE, grantFor(item.id, BOB, NOW, NOW + 10), NOW + 10),
      { denied: true, reason: "grant-window" },
    );
    cancelSee(acl, ALICE, BOB, item.id);
    assert.deepEqual(
      prepareGrantItemDelivery(acl, item, ALICE, grantFor(item.id), NOW),
      { denied: true, reason: "check" },
    );
  });
});

describe("prepareGrantRoomDelivery", () => {
  it("delivers the room node and not Public / Network lists", () => {
    const acl = createMemorySeeAcl();
    const room = mineRoom();
    admitComposedRoom(acl, room, ALICE);
    applySeeGrant(acl, ALICE, grantFor(room.id));
    const prepared = prepareGrantRoomDelivery(acl, room, ALICE, grantFor(room.id), NOW);
    assert.ok(!("denied" in prepared));
    assert.equal(prepared.kindKey, "rooms");
    assert.equal(prepared.soul, grantedSoul(BOB, "rooms", room.id));
    assert.equal(roomsForTab("public", [], [room]).length, 0);
    assert.equal(roomsForTab("network", [], [room], []).length, 0);
    assert.equal(roomsForTab("granted", [], [room], [], [room])[0]?.id, room.id);
  });
});

describe("prepareGrantUserDelivery", () => {
  it("delivers only the granted claim, not the private footprint", () => {
    const acl = createMemorySeeAcl();
    const user = composeUser({
      address: ALICE,
      indicators: ["ens:vitalik.eth", "farcaster:dwr"],
      nowSeconds: NOW,
    });
    assert.ok(user);
    admitComposedUser(acl, user, ALICE);
    const grant = grantFor("ens:vitalik.eth");
    applySeeGrant(acl, ALICE, grant);
    const prepared = prepareGrantUserDelivery(acl, user, ALICE, grant, NOW);
    assert.ok(!("denied" in prepared));
    assert.equal(prepared.kindKey, "users");
    assert.equal(prepared.soul, grantedSoul(BOB, "users", "ens:vitalik.eth"));
    if ("retracted" in prepared.node) return;
    assert.equal(prepared.node.payload.includes("ens:vitalik.eth"), true);
    assert.equal(prepared.node.payload.includes("farcaster:dwr"), false);
    assert.equal(prepared.node.payload.includes("priv"), false);
  });
});

describe("acceptGrantDelivery", () => {
  it("accessor observes the object only with a live grant", () => {
    const holder = createMemorySeeAcl();
    const accessor = createMemorySeeAcl();
    const item = nativePost("hello bob", "dd44");
    admitNativePost(holder, item, ALICE);
    const grant = grantFor(item.id);
    applySeeGrant(holder, ALICE, grant);
    const prepared = prepareGrantItemDelivery(holder, item, ALICE, grant, NOW);
    assert.ok(!("denied" in prepared));

    const accepted = acceptGrantDelivery(accessor, prepared.node, BOB, NOW);
    assert.ok(!("denied" in accepted));
    assert.ok(!("retracted" in accepted));
    assert.equal(accepted.kind, "item");
    if (accepted.kind !== "item") return;
    assert.equal(accepted.item.body, "hello bob");
    assert.equal(checkSee(accessor, itemSoul(item.id), BOB, NOW).allowed, true);
    assert.equal(checkSee(accessor, itemSoul(item.id), CAROL, NOW).allowed, false);

    const publicSeed: FeedItem[] = [];
    assert.equal(itemsForTab("public", publicSeed, [item]).length, 0);
    assert.equal(itemsForTab("network", publicSeed, [item], []).length, 0);
    assert.equal(
      itemsForTab("granted", publicSeed, [item], [], [accepted.item])[0]?.id,
      item.id,
    );
  });

  it("without a grant (or after revoke) they cannot keep the object", () => {
    const holder = createMemorySeeAcl();
    const accessor = createMemorySeeAcl();
    const item = nativePost("revoked", "ee55");
    admitNativePost(holder, item, ALICE);
    const grant = grantFor(item.id);
    applySeeGrant(holder, ALICE, grant);
    const prepared = prepareGrantItemDelivery(holder, item, ALICE, grant, NOW);
    assert.ok(!("denied" in prepared));
    assert.ok(!("denied" in acceptGrantDelivery(accessor, prepared.node, BOB, NOW)));

    cancelSee(holder, ALICE, BOB, item.id);
    assert.equal(checkSee(holder, itemSoul(item.id), BOB, NOW).allowed, false);

    const retract = prepareGrantRetract(ALICE, grant, "item", item.id, NOW);
    assert.ok(!("denied" in retract));
    assert.equal(isGrantTombstone(retract.node), true);
    const dropped = acceptGrantDelivery(accessor, retract.node, BOB, NOW);
    assert.deepEqual(dropped, {
      retracted: true,
      objectId: item.id,
      kind: "item",
    });
    assert.equal(checkSee(accessor, itemSoul(item.id), BOB, NOW).allowed, false);
  });

  it("expired window and wrong accessor fail closed", () => {
    const holder = createMemorySeeAcl();
    const accessor = createMemorySeeAcl();
    const item = nativePost("window", "ff66");
    admitNativePost(holder, item, ALICE);
    const grant = grantFor(item.id, BOB, NOW, NOW + 5);
    applySeeGrant(holder, ALICE, grant);
    const prepared = prepareGrantItemDelivery(holder, item, ALICE, grant, NOW);
    assert.ok(!("denied" in prepared));
    assert.deepEqual(acceptGrantDelivery(accessor, prepared.node, CAROL, NOW), {
      denied: true,
      reason: "accessor",
    });
    assert.deepEqual(acceptGrantDelivery(accessor, prepared.node, BOB, NOW + 5), {
      denied: true,
      reason: "expired",
    });
  });

  it("unknown v and secrets fail closed", () => {
    const accessor = createMemorySeeAcl();
    assert.equal(fromGrantDeliveryNode({ kind: "item", v: 2, objectId: "x" }), null);
    assert.equal(
      fromGrantDeliveryNode({
        kind: "item",
        objectId: "x",
        owner: ALICE,
        accessor: BOB,
        from: NOW,
        until: NOW + 1,
        payload: "{}",
        priv: "nope",
      }),
      null,
    );
    assert.deepEqual(
      acceptGrantDelivery(
        accessor,
        {
          kind: "item",
          objectId: "x",
          owner: ALICE,
          accessor: BOB,
          from: NOW,
          until: NOW + 1,
          payload: JSON.stringify({ id: "x", priv: "nope" }),
          v: 1,
        },
        BOB,
        NOW,
      ),
      { denied: true, reason: "payload" },
    );
  });
});

describe("grant delivery vs share-into-mesh", () => {
  it("does not move an unshared Mine post onto Public or Network", () => {
    const acl = createMemorySeeAcl();
    const item = nativePost("still mine", "9900");
    admitNativePost(acl, item, ALICE);
    applySeeGrant(acl, ALICE, grantFor(item.id));
    const prepared = prepareGrantItemDelivery(acl, item, ALICE, grantFor(item.id), NOW);
    assert.ok(!("denied" in prepared));
    const seed: FeedItem[] = [];
    const overlay = [item];
    assert.equal(itemsForTab("public", seed, overlay).some((row) => row.id === item.id), false);
    assert.equal(itemsForTab("network", seed, overlay, []).some((row) => row.id === item.id), false);
    assert.equal(itemsForTab("mine", seed, overlay)[0]?.id, item.id);
  });
});
