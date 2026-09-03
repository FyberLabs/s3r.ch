import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  admitComposedChat,
  composeChat,
  fromGunChatNode,
  mergeChat,
  messagesInRoom,
  preparePublishRoomChat,
  preparePutRoomChat,
  rankChatMessages,
  roomChatOnPublicGraph,
  toGunChatNode,
  type ChatMessage,
} from "./chat";
import {
  applySeeGrant,
  checkSee,
  chatSoul,
} from "./identity/check";
import { createMemorySeeAcl } from "./identity/see-acl";
import { composeRoom } from "./rooms";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const NOW = 1_700_000_000;

function roomId(entropy = "ab12cd"): string {
  const built = composeRoom({
    title: "Lab thread",
    address: ALICE,
    nowSeconds: NOW,
    entropy,
  });
  assert.ok(built);
  return built.id;
}

function chat(overrides: Partial<ComposeChatLike> = {}): ChatMessage {
  const built = composeChat({
    body: "hello room",
    roomId: roomId(),
    address: ALICE,
    nowSeconds: NOW,
    entropy: "cafeba",
    ...overrides,
  });
  assert.ok(built);
  return built;
}

type ComposeChatLike = {
  body: string;
  roomId: string;
  address: string;
  nowSeconds?: number;
  entropy?: string;
};

describe("GunChatNode", () => {
  it("toGunChatNode / fromGunChatNode round-trip", () => {
    const built = composeChat({
      body: "  ping  ",
      roomId: roomId("deadbeef"),
      address: ALICE.toLowerCase(),
      nowSeconds: NOW,
      entropy: "aabbcc",
    });
    assert.ok(built);
    assert.equal(built.body, "ping");
    assert.equal(built.author, ALICE);
    assert.equal(built.v, 1);
    const node = toGunChatNode(built);
    assert.equal(node.body, "ping");
    assert.equal(node.author, ALICE);
    assert.equal(node.room, built.room);
    assert.equal(node.v, 1);
    assert.equal(fromGunChatNode(node)?.id, built.id);
    assert.deepEqual(fromGunChatNode(node), built);
    assert.equal(fromGunChatNode({ ...node, v: undefined })?.id, built.id);
    assert.equal(fromGunChatNode({ ...node, v: 2 }), null);
  });

  it("fromGunChatNode rejects empty body, bad author, missing room", () => {
    const built = chat();
    const node = toGunChatNode(built);
    assert.equal(fromGunChatNode({ ...node, body: "   " }), null);
    assert.equal(fromGunChatNode({ ...node, author: "not-an-address" }), null);
    assert.equal(fromGunChatNode({ ...node, room: "" }), null);
    assert.equal(fromGunChatNode({ ...node, id: "" }), null);
  });
});

describe("composeChat", () => {
  it("builds a valid message", () => {
    const room = roomId("cafebabe");
    const built = composeChat({
      body: "  a line  ",
      roomId: room,
      address: ALICE.toLowerCase(),
      nowSeconds: NOW,
      entropy: "112233",
    });
    assert.ok(built);
    assert.equal(built.body, "a line");
    assert.equal(built.author, ALICE);
    assert.equal(built.room, room);
    assert.equal(built.ts, NOW);
    assert.equal(built.id, `s3rch:chat:${ALICE}:${NOW}:112233`);
    assert.equal(built.v, 1);
  });

  it("rejects an empty body", () => {
    assert.equal(
      composeChat({ body: "", roomId: roomId(), address: ALICE, entropy: "aa" }),
      null,
    );
    assert.equal(
      composeChat({ body: "   ", roomId: roomId(), address: ALICE, entropy: "aa" }),
      null,
    );
  });

  it("rejects a body that is too long", () => {
    assert.equal(
      composeChat({
        body: "x".repeat(281),
        roomId: roomId(),
        address: ALICE,
        entropy: "aa",
      }),
      null,
    );
  });

  it("rejects a bad author or empty room", () => {
    assert.equal(
      composeChat({
        body: "ok",
        roomId: roomId(),
        address: "not-an-address",
        entropy: "aa",
      }),
      null,
    );
    assert.equal(
      composeChat({ body: "ok", roomId: "  ", address: ALICE, entropy: "aa" }),
      null,
    );
  });
});

describe("admit before overlay / public put", () => {
  it("admitChatNode is required before overlay register / Gun put", () => {
    const acl = createMemorySeeAcl();
    const built = chat({ entropy: "admit1" });
    const garbage = admitComposedChat(acl, { ...built, id: "" }, ALICE);
    assert.deepEqual(garbage, { denied: true });
    assert.equal(acl.hasObject(chatSoul(built.room, built.id)), false);

    const registered = admitComposedChat(acl, built, ALICE);
    assert.ok(!("denied" in registered));
    assert.equal(registered.object, chatSoul(built.room, built.id));
    assert.equal(acl.hasObject(chatSoul(built.room, built.id)), true);

    const deniedPut = preparePutRoomChat(acl, { ...built, id: "" }, ALICE);
    assert.deepEqual(deniedPut, { denied: true });

    const put = preparePutRoomChat(acl, built, ALICE);
    assert.ok(!("denied" in put));
    assert.equal(put.key, built.id.replace(/[.#$[\]]/g, "_"));
    assert.equal(put.roomKey, built.room.replace(/[.#$[\]]/g, "_"));
    assert.equal(put.node.body, built.body);
    assert.equal(put.node.author, ALICE);
  });

  it("unknown v fails closed on admit", () => {
    const acl = createMemorySeeAcl();
    const built = chat({ entropy: "vfail" });
    const denied = admitComposedChat(acl, { ...built, v: 2 }, ALICE);
    assert.deepEqual(denied, { denied: true });
    assert.equal(acl.hasObject(chatSoul(built.room, built.id)), false);
    const missingV = admitComposedChat(acl, { ...built, v: undefined }, ALICE);
    assert.ok(!("denied" in missingV));
  });
});

describe("Mine overlay vs public room path", () => {
  it("does not publish chat while the room is Mine-only", () => {
    const acl = createMemorySeeAcl();
    const built = chat({ entropy: "mine1" });
    const denied = preparePublishRoomChat(acl, built, ALICE, []);
    assert.deepEqual(denied, { denied: true });
    assert.equal(roomChatOnPublicGraph(built.room, []), false);

    const overlay: ChatMessage[] = [built];
    const graph: ChatMessage[] = [];
    assert.equal(messagesInRoom(overlay, built.room)[0]?.id, built.id);
    assert.equal(messagesInRoom(graph, built.room).length, 0);
  });

  it("publishes onto the room chat path only after the room is on s3rch/rooms", () => {
    const acl = createMemorySeeAcl();
    const built = chat({ entropy: "pub1" });
    assert.equal(roomChatOnPublicGraph(built.room, [built.room]), true);
    const published = preparePublishRoomChat(acl, built, ALICE, [built.room]);
    assert.ok(!("denied" in published));
    assert.equal(published.node.room, built.room);
    assert.equal(published.node.v, 1);
  });

  it("sharing a room is not required to admit overlay chat", () => {
    const acl = createMemorySeeAcl();
    const built = chat({ entropy: "ov1" });
    const admitted = admitComposedChat(acl, built, ALICE);
    assert.ok(!("denied" in admitted));
    assert.deepEqual(preparePublishRoomChat(acl, built, ALICE, []), {
      denied: true,
    });
  });
});

describe("Check see on a chat object", () => {
  it("owner vs grant vs missing on a chat object", () => {
    const acl = createMemorySeeAcl();
    const built = chat({ entropy: "see1" });
    assert.deepEqual(admitComposedChat(acl, built, ALICE), {
      message: built,
      object: chatSoul(built.room, built.id),
    });
    const object = chatSoul(built.room, built.id);
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

  it("a see-grant is not a public put", () => {
    const acl = createMemorySeeAcl();
    const built = chat({ entropy: "see2" });
    admitComposedChat(acl, built, ALICE);
    applySeeGrant(acl, ALICE, {
      claimId: chatSoul(built.room, built.id),
      accessor: BOB,
      from: 0,
      until: NOW + 1,
    });
    assert.equal(checkSee(acl, chatSoul(built.room, built.id), BOB, NOW).allowed, true);
    assert.deepEqual(preparePublishRoomChat(acl, built, ALICE, []), { denied: true });
  });
});

describe("room thread filter and recency", () => {
  it("messagesInRoom keeps only that room", () => {
    const a = roomId("55");
    const b = roomId("66");
    const inA = chat({ roomId: a, entropy: "in-a", body: "in a" });
    const inB = chat({ roomId: b, entropy: "in-b", body: "in b" });
    assert.deepEqual(
      messagesInRoom([inA, inB], a).map((row) => row.id),
      [inA.id],
    );
  });

  it("rankChatMessages is recency then id", () => {
    const room = roomId("77");
    const older = chat({
      roomId: room,
      body: "older",
      nowSeconds: NOW - 10,
      entropy: "old",
    });
    const newer = chat({
      roomId: room,
      body: "newer",
      nowSeconds: NOW,
      entropy: "new",
    });
    const ranked = rankChatMessages([older, newer]);
    assert.deepEqual(
      ranked.map((row) => row.id),
      [newer.id, older.id],
    );
  });

  it("mergeChat first-seen wins and ranks", () => {
    const room = roomId("88");
    const first = chat({ roomId: room, body: "first", entropy: "m1" });
    const later = { ...first, body: "should not replace" };
    const extra = chat({
      roomId: room,
      body: "extra",
      nowSeconds: NOW + 5,
      entropy: "m2",
    });
    const merged = mergeChat([first], [later, extra]);
    assert.equal(merged.find((row) => row.id === first.id)?.body, "first");
    assert.equal(merged[0]?.id, extra.id);
  });
});
