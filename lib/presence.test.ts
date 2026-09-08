import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  admitComposedPresence,
  composePresence,
  composePresenceLeave,
  fromGunPresenceNode,
  isPresenceLive,
  livePresence,
  mergePresence,
  presenceDisplayName,
  presenceInRoom,
  preparePublishRoomPresence,
  preparePutRoomPresence,
  PRESENCE_TTL_SECONDS,
  roomPresenceOnPublicGraph,
  shortPresenceAddress,
  toGunPresenceNode,
  type PresenceEntry,
} from "./presence";
import {
  applySeeGrant,
  checkSee,
  presenceSoul,
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

function presence(overrides: Partial<ComposePresenceLike> = {}): PresenceEntry {
  const built = composePresence({
    roomId: roomId(),
    address: ALICE,
    nowSeconds: NOW,
    ...overrides,
  });
  assert.ok(built);
  return built;
}

type ComposePresenceLike = {
  roomId: string;
  address: string;
  nowSeconds?: number;
};

describe("GunPresenceNode", () => {
  it("toGunPresenceNode / fromGunPresenceNode round-trip", () => {
    const built = composePresence({
      roomId: roomId("deadbeef"),
      address: ALICE.toLowerCase(),
      nowSeconds: NOW,
    });
    assert.ok(built);
    assert.equal(built.address, ALICE);
    assert.equal(built.v, 1);
    const node = toGunPresenceNode(built);
    assert.equal(node.address, ALICE);
    assert.equal(node.room, built.room);
    assert.equal(node.ts, NOW);
    assert.equal(node.v, 1);
    assert.deepEqual(fromGunPresenceNode(node), built);
    assert.equal(fromGunPresenceNode({ ...node, v: undefined })?.address, ALICE);
    assert.equal(fromGunPresenceNode({ ...node, v: 2 }), null);
  });

  it("fromGunPresenceNode rejects bad address, missing room, missing ts", () => {
    const built = presence();
    const node = toGunPresenceNode(built);
    assert.equal(fromGunPresenceNode({ ...node, address: "not-an-address" }), null);
    assert.equal(fromGunPresenceNode({ ...node, room: "" }), null);
    assert.equal(fromGunPresenceNode({ ...node, ts: Number.NaN }), null);
    assert.equal(fromGunPresenceNode({ ...node, ts: undefined }), null);
  });
});

describe("composePresence", () => {
  it("builds a valid heartbeat", () => {
    const room = roomId("cafebabe");
    const built = composePresence({
      roomId: room,
      address: ALICE.toLowerCase(),
      nowSeconds: NOW,
    });
    assert.ok(built);
    assert.equal(built.address, ALICE);
    assert.equal(built.room, room);
    assert.equal(built.ts, NOW);
    assert.equal(built.v, 1);
  });

  it("rejects a bad address or empty room", () => {
    assert.equal(
      composePresence({ roomId: roomId(), address: "not-an-address" }),
      null,
    );
    assert.equal(composePresence({ roomId: "  ", address: ALICE }), null);
  });

  it("composePresenceLeave writes a ts that is immediately expired", () => {
    const built = composePresenceLeave({
      roomId: roomId("leave1"),
      address: ALICE,
      nowSeconds: NOW,
    });
    assert.ok(built);
    assert.equal(built.ts, NOW - PRESENCE_TTL_SECONDS);
    assert.equal(isPresenceLive(built, NOW), false);
  });
});

describe("admit before overlay / public put", () => {
  it("admitPresenceNode is required before overlay register / Gun put", () => {
    const acl = createMemorySeeAcl();
    const built = presence();
    const garbage = admitComposedPresence(
      acl,
      { ...built, room: "" },
      ALICE,
    );
    assert.deepEqual(garbage, { denied: true });
    assert.equal(acl.hasObject(presenceSoul(built.room, built.address)), false);

    const registered = admitComposedPresence(acl, built, ALICE);
    assert.ok(!("denied" in registered));
    assert.equal(registered.object, presenceSoul(built.room, built.address));
    assert.equal(acl.hasObject(presenceSoul(built.room, built.address)), true);

    const deniedPut = preparePutRoomPresence(
      acl,
      { ...built, address: "not-an-address" },
      ALICE,
    );
    assert.deepEqual(deniedPut, { denied: true });

    const put = preparePutRoomPresence(acl, built, ALICE);
    assert.ok(!("denied" in put));
    assert.equal(put.key, built.address.replace(/[.#$[\]]/g, "_"));
    assert.equal(put.roomKey, built.room.replace(/[.#$[\]]/g, "_"));
    assert.equal(put.node.address, ALICE);
    assert.equal(put.node.ts, NOW);
  });

  it("unknown v fails closed on admit; missing v reads as v1", () => {
    const acl = createMemorySeeAcl();
    const built = presence();
    const denied = admitComposedPresence(acl, { ...built, v: 2 }, ALICE);
    assert.deepEqual(denied, { denied: true });
    assert.equal(acl.hasObject(presenceSoul(built.room, built.address)), false);
    const missingV = admitComposedPresence(acl, { ...built, v: undefined }, ALICE);
    assert.ok(!("denied" in missingV));
  });

  it("cannot admit another address's presence", () => {
    const acl = createMemorySeeAcl();
    const built = presence({ address: BOB });
    assert.deepEqual(admitComposedPresence(acl, built, ALICE), { denied: true });
    assert.equal(acl.hasObject(presenceSoul(built.room, BOB)), false);
    const own = admitComposedPresence(acl, built, BOB);
    assert.ok(!("denied" in own));
  });
});

describe("Mine overlay vs public room path", () => {
  it("does not publish presence while the room is Mine-only", () => {
    const acl = createMemorySeeAcl();
    const built = presence();
    const denied = preparePublishRoomPresence(acl, built, ALICE, []);
    assert.deepEqual(denied, { denied: true });
    assert.equal(roomPresenceOnPublicGraph(built.room, []), false);

    const overlay: PresenceEntry[] = [built];
    const graph: PresenceEntry[] = [];
    assert.equal(presenceInRoom(overlay, built.room)[0]?.address, ALICE);
    assert.equal(presenceInRoom(graph, built.room).length, 0);
  });

  it("publishes onto the room presence path only after the room is on s3rch/rooms", () => {
    const acl = createMemorySeeAcl();
    const built = presence();
    assert.equal(roomPresenceOnPublicGraph(built.room, [built.room]), true);
    const published = preparePublishRoomPresence(acl, built, ALICE, [built.room]);
    assert.ok(!("denied" in published));
    assert.equal(published.node.room, built.room);
    assert.equal(published.node.v, 1);
    assert.equal(published.node.address, ALICE);
  });

  it("sharing a room is not required to admit overlay presence", () => {
    const acl = createMemorySeeAcl();
    const built = presence();
    const admitted = admitComposedPresence(acl, built, ALICE);
    assert.ok(!("denied" in admitted));
    assert.deepEqual(preparePublishRoomPresence(acl, built, ALICE, []), {
      denied: true,
    });
  });
});

describe("Check see on a presence object", () => {
  it("owner vs grant vs missing on a presence object", () => {
    const acl = createMemorySeeAcl();
    const built = presence();
    assert.deepEqual(admitComposedPresence(acl, built, ALICE), {
      entry: built,
      object: presenceSoul(built.room, built.address),
    });
    const object = presenceSoul(built.room, built.address);
    assert.equal(checkSee(acl, object, ALICE, NOW).allowed, true);
    assert.equal(checkSee(acl, object, ALICE, NOW).reason, "owner");
    const missing = checkSee(acl, object, BOB, NOW);
    assert.equal(missing.allowed, false);
    assert.equal(missing.reason, "missing-grant");

    applySeeGrant(acl, ALICE, {
      claimId: object,
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
    const built = presence();
    admitComposedPresence(acl, built, ALICE);
    applySeeGrant(acl, ALICE, {
      claimId: presenceSoul(built.room, built.address),
      accessor: BOB,
      from: 0,
      until: NOW + 1,
    });
    assert.equal(
      checkSee(acl, presenceSoul(built.room, built.address), BOB, NOW).allowed,
      true,
    );
    assert.deepEqual(preparePublishRoomPresence(acl, built, ALICE, []), {
      denied: true,
    });
  });
});

describe("TTL and merge", () => {
  it("isPresenceLive / livePresence expire after the soft TTL", () => {
    const room = roomId("ttl1");
    const fresh = presence({ roomId: room, nowSeconds: NOW });
    const stale = presence({
      roomId: room,
      address: BOB,
      nowSeconds: NOW - PRESENCE_TTL_SECONDS,
    });
    assert.equal(isPresenceLive(fresh, NOW), true);
    assert.equal(isPresenceLive(stale, NOW), false);
    assert.equal(isPresenceLive(fresh, NOW + PRESENCE_TTL_SECONDS), false);
    const live = livePresence([fresh, stale], NOW);
    assert.deepEqual(
      live.map((row) => row.address),
      [ALICE],
    );
  });

  it("presenceInRoom keeps only that room", () => {
    const a = roomId("55");
    const b = roomId("66");
    const inA = presence({ roomId: a });
    const inB = presence({ roomId: b, address: BOB });
    assert.deepEqual(
      presenceInRoom([inA, inB], a).map((row) => row.address),
      [ALICE],
    );
  });

  it("mergePresence latest ts per address wins", () => {
    const room = roomId("88");
    const first = presence({ roomId: room, nowSeconds: NOW });
    const later = { ...first, ts: NOW + 25 };
    const extra = presence({
      roomId: room,
      address: BOB,
      nowSeconds: NOW + 5,
    });
    const merged = mergePresence([first], [later, extra]);
    assert.equal(merged.find((row) => row.address === ALICE)?.ts, NOW + 25);
    assert.equal(merged.length, 2);
  });

  it("presenceDisplayName prefers a local held claim, else short address", () => {
    assert.equal(shortPresenceAddress(ALICE), "0xf39F…2266");
    assert.equal(presenceDisplayName(ALICE), "0xf39F…2266");
    assert.equal(presenceDisplayName(ALICE, "vitalik.eth"), "vitalik.eth");
    assert.equal(presenceDisplayName(ALICE, "  "), "0xf39F…2266");
  });
});
