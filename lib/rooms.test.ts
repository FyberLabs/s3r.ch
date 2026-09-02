import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitNativePost, composeNativePost } from "./compose";
import { rankFeedItems } from "./feed-rank";
import { itemsForTab } from "./feed-tabs";
import type { FeedItem } from "./feed-types";
import {
  applySeeGrant,
  checkSee,
  roomSoul,
} from "./identity/check";
import { createMemorySeeAcl } from "./identity/see-acl";
import {
  admitComposedRoom,
  composeNativePostInRoom,
  composeRoom,
  fromGunRoomNode,
  itemsInRoom,
  ownedRooms,
  prepareShareRoomIntoMesh,
  rankRooms,
  roomsForTab,
  roomTag,
  toGunRoomNode,
  type Room,
} from "./rooms";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const NOW = 1_700_000_000;

function room(overrides: Partial<ComposeRoomLike> = {}): Room {
  const built = composeRoom({
    title: "Lab thread",
    address: ALICE,
    nowSeconds: NOW,
    entropy: "ab12cd",
    ...overrides,
  });
  assert.ok(built);
  return built;
}

type ComposeRoomLike = {
  title: string;
  address: string;
  tags?: string[];
  nowSeconds?: number;
  entropy?: string;
};

describe("GunRoomNode csv tags", () => {
  it("toGunRoomNode / fromGunRoomNode round-trip", () => {
    const built = composeRoom({
      title: "  Mesh notes  ",
      address: ALICE.toLowerCase(),
      tags: ["Lab", "lab", "mesh"],
      nowSeconds: NOW,
      entropy: "deadbeef",
    });
    assert.ok(built);
    assert.equal(built.title, "Mesh notes");
    assert.equal(built.owner, ALICE);
    assert.deepEqual(built.tags, ["lab", "mesh", "room", "s3rch"]);
    const node = toGunRoomNode(built);
    assert.equal(node.tags, "lab,mesh,room,s3rch");
    assert.equal(node.owner, ALICE);
    assert.equal(node.provenance, `s3rch:room:${ALICE}`);
    assert.equal(node.v, 1);
    const back = fromGunRoomNode(node);
    assert.deepEqual(back, built);
    assert.equal(fromGunRoomNode({ ...node, v: undefined })?.id, built.id);
    assert.equal(fromGunRoomNode({ ...node, v: 2 }), null);
  });

  it("fromGunRoomNode rejects empty title or bad owner", () => {
    const built = room();
    const node = toGunRoomNode(built);
    assert.equal(fromGunRoomNode({ ...node, title: "   " }), null);
    assert.equal(fromGunRoomNode({ ...node, owner: "not-an-address" }), null);
    assert.equal(fromGunRoomNode({ ...node, id: "" }), null);
  });
});

describe("composeRoom", () => {
  it("builds a valid room", () => {
    const built = composeRoom({
      title: "  a room  ",
      address: ALICE.toLowerCase(),
      tags: ["mesh"],
      nowSeconds: NOW,
      entropy: "cafebabe",
    });
    assert.ok(built);
    assert.equal(built.title, "a room");
    assert.equal(built.owner, ALICE);
    assert.equal(built.ts, NOW);
    assert.equal(built.id, `s3rch:room:${ALICE}:${NOW}:cafebabe`);
    assert.equal(built.provenance, `s3rch:room:${ALICE}`);
    assert.deepEqual(built.tags, ["mesh", "room", "s3rch"]);
    assert.equal(built.v, 1);
  });

  it("rejects an empty title", () => {
    assert.equal(composeRoom({ title: "", address: ALICE, entropy: "aa" }), null);
    assert.equal(composeRoom({ title: "   ", address: ALICE, entropy: "aa" }), null);
  });

  it("rejects a title that is too long", () => {
    assert.equal(
      composeRoom({ title: "x".repeat(81), address: ALICE, entropy: "aa" }),
      null,
    );
  });

  it("rejects a bad owner", () => {
    assert.equal(
      composeRoom({ title: "ok", address: "not-an-address", entropy: "aa" }),
      null,
    );
  });
});

describe("admit before overlay / share", () => {
  it("admitRoomNode is required before overlay register / share put", () => {
    const acl = createMemorySeeAcl();
    const built = room();
    const garbage = admitComposedRoom(acl, { ...built, id: "" }, ALICE);
    assert.deepEqual(garbage, { denied: true });
    assert.equal(acl.hasObject(roomSoul(built.id)), false);

    const registered = admitComposedRoom(acl, built, ALICE);
    assert.ok(!("denied" in registered));
    assert.equal(registered.object, roomSoul(built.id));
    assert.equal(acl.hasObject(roomSoul(built.id)), true);

    const deniedShare = prepareShareRoomIntoMesh(acl, { ...built, id: "" }, ALICE);
    assert.deepEqual(deniedShare, { denied: true });

    const share = prepareShareRoomIntoMesh(acl, built, ALICE);
    assert.ok(!("denied" in share));
    assert.equal(share.key, built.id.replace(/[.#$[\]]/g, "_"));
    assert.equal(share.node.title, built.title);
    assert.equal(share.node.owner, ALICE);
  });
});

describe("Public / Mine room lists", () => {
  it("Public rooms list excludes unshared rooms", () => {
    const mineOnly = room({ title: "still mine", entropy: "aabbcc" });
    const shared = room({ title: "published", entropy: "ddeeff" });
    const pub = roomsForTab("public", [shared], [mineOnly, shared]);
    assert.equal(pub.some((row) => row.id === mineOnly.id), false);
    assert.equal(pub.some((row) => row.id === shared.id), true);
  });

  it("Mine rooms include owned rooms", () => {
    const aliceRoom = room({ title: "alice", entropy: "111111" });
    const bobRoom = composeRoom({
      title: "bob",
      address: BOB,
      nowSeconds: NOW,
      entropy: "222222",
    });
    assert.ok(bobRoom);
    const mine = roomsForTab(
      "mine",
      [],
      ownedRooms([aliceRoom, bobRoom], ALICE),
    );
    assert.equal(mine.some((row) => row.id === aliceRoom.id), true);
    assert.equal(mine.some((row) => row.id === bobRoom.id), false);
  });
});

describe("Check see on a room", () => {
  it("owner vs grant vs missing on a room object", () => {
    const acl = createMemorySeeAcl();
    const built = room({ title: "granted later", entropy: "33" });
    assert.deepEqual(admitComposedRoom(acl, built, ALICE), {
      room: built,
      object: roomSoul(built.id),
    });
    const object = roomSoul(built.id);
    assert.equal(checkSee(acl, object, ALICE, NOW).allowed, true);
    assert.equal(checkSee(acl, object, ALICE, NOW).reason, "owner");
    const missing = checkSee(acl, object, BOB, NOW);
    assert.equal(missing.allowed, false);
    assert.equal(missing.reason, "missing-grant");

    applySeeGrant(acl, ALICE, {
      claimId: built.id,
      accessor: BOB,
      from: NOW,
      until: NOW + 60,
    });
    const granted = checkSee(acl, object, BOB, NOW);
    assert.equal(granted.allowed, true);
    assert.equal(granted.reason, "see-grant");
  });

  it("applySeeGrant on a room is not a public share", () => {
    const acl = createMemorySeeAcl();
    const built = room({ title: "grant ≠ publish", entropy: "44" });
    admitComposedRoom(acl, built, ALICE);
    applySeeGrant(acl, ALICE, {
      claimId: built.id,
      accessor: BOB,
      from: 0,
      until: NOW + 1,
    });

    const publicRooms: Room[] = [];
    const mineRooms = [built];
    assert.equal(roomsForTab("public", publicRooms, mineRooms).length, 0);
    assert.equal(roomsForTab("mine", publicRooms, mineRooms)[0]?.id, built.id);
    assert.equal(checkSee(acl, roomSoul(built.id), BOB, NOW).allowed, true);

    const share = prepareShareRoomIntoMesh(acl, built, ALICE);
    assert.ok(!("denied" in share));
    publicRooms.push(built);
    assert.equal(roomsForTab("public", publicRooms, mineRooms)[0]?.id, built.id);
  });
});

describe("room thread filter and share isolation", () => {
  it("native post with room tag appears; untagged post does not", () => {
    const built = room({ entropy: "55" });
    const tagged = composeNativePostInRoom({
      body: "in the room",
      address: ALICE,
      roomId: built.id,
      nowSeconds: NOW,
      entropy: "post1",
    });
    const untagged = composeNativePost({
      body: "not in the room",
      address: ALICE,
      nowSeconds: NOW,
      entropy: "post2",
    });
    assert.ok(tagged);
    assert.ok(untagged);
    assert.ok(tagged.tags.includes(roomTag(built.id)));
    assert.ok(tagged.tags.includes("user"));
    assert.ok(tagged.tags.includes("s3rch"));
    const thread = itemsInRoom([tagged, untagged], built.id);
    assert.deepEqual(
      thread.map((row) => row.id),
      [tagged.id],
    );
  });

  it("sharing a room does not move unshared posts onto Public", () => {
    const acl = createMemorySeeAcl();
    const built = room({ entropy: "66" });
    admitComposedRoom(acl, built, ALICE);
    const post = composeNativePostInRoom({
      body: "still mine",
      address: ALICE,
      roomId: built.id,
      nowSeconds: NOW,
      entropy: "post3",
    });
    assert.ok(post);
    admitNativePost(acl, post, ALICE);

    const share = prepareShareRoomIntoMesh(acl, built, ALICE);
    assert.ok(!("denied" in share));
    const publicRooms = [built];
    const seed: FeedItem[] = [];
    const overlay = [post];

    assert.equal(roomsForTab("public", publicRooms, [built]).some((row) => row.id === built.id), true);
    assert.equal(itemsForTab("public", seed, overlay).some((row) => row.id === post.id), false);
    assert.equal(itemsForTab("mine", seed, overlay)[0]?.id, post.id);
  });

  it("ranker still works on room-filtered posts", () => {
    const built = room({ entropy: "77" });
    const older = composeNativePostInRoom({
      body: "older room note",
      address: ALICE,
      roomId: built.id,
      tags: ["lab"],
      nowSeconds: NOW - 10,
      entropy: "old",
    });
    const newer = composeNativePostInRoom({
      body: "newer room note",
      address: ALICE,
      roomId: built.id,
      tags: ["lab", "mesh"],
      nowSeconds: NOW,
      entropy: "new",
    });
    const outside = composeNativePost({
      body: "outside",
      address: ALICE,
      tags: ["lab", "mesh"],
      nowSeconds: NOW + 10,
      entropy: "out",
    });
    assert.ok(older);
    assert.ok(newer);
    assert.ok(outside);
    const thread = itemsInRoom([outside, older, newer], built.id);
    assert.equal(thread.length, 2);
    const ranked = rankFeedItems(thread, ["lab", "mesh"]);
    assert.deepEqual(
      ranked.map((row) => row.id),
      [newer.id, older.id],
    );
    const recency = rankFeedItems(thread, []);
    assert.equal(recency[0]?.id, newer.id);
    assert.equal(recency[1]?.id, older.id);
  });

  it("rankRooms filters by tags then recency", () => {
    const twoOld = room({ title: "two-old", tags: ["social", "mesh"], nowSeconds: 10, entropy: "a" });
    const twoNew = room({ title: "two-new", tags: ["social", "mesh"], nowSeconds: 30, entropy: "b" });
    const one = room({ title: "one", tags: ["social"], nowSeconds: 40, entropy: "c" });
    const none = room({ title: "none", tags: ["rss"], nowSeconds: 50, entropy: "d" });
    const ranked = rankRooms([none, one, twoOld, twoNew], ["social", "mesh"]);
    assert.deepEqual(
      ranked.map((row) => row.title),
      ["two-new", "two-old", "one"],
    );
  });
});
