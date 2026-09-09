import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fromGunNode, toGunNode, type FeedItem, type GunFeedNode } from "@/lib/feed-types";
import {
  acceptHint,
  acceptHop,
  admitChatNode,
  admitFeedNode,
  admitPresenceNode,
  admitRoomNode,
  admitUserNode,
  applySeeGrant,
  aclKey,
  aclPrincipalKey,
  aclSoul,
  cancelSee,
  checkSee,
  checkSeeGrant,
  chatSoul,
  decodeHop,
  encodeKey,
  grantSoul,
  presenceSoul,
  grantLiveAt,
  grantedSoul,
  itemSoul,
  metaSoul,
  roomSoul,
  userSoul,
  type HandoffHint,
  type HopFactor,
  type SeeGraph,
} from "./check";
import { createMemorySeeAcl } from "./see-acl";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CAROL = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const CLAIM = "ens:vitalik.eth";
const NOW = 1_000;

const HERE = dirname(fileURLToPath(import.meta.url));

function sampleItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "rss3:act/1#x",
    source: "rss3",
    kind: "social",
    author: "0xalice",
    body: "hello",
    ts: 1,
    permalink: "https://gi.rss3.io/decentralized/0xalice",
    tags: ["Social", "farcaster", "social"],
    provenance: "rss3:gi",
    ...overrides,
  };
}

function hint(overrides: Partial<HandoffHint> = {}): HandoffHint {
  return {
    principal: BOB,
    target: CLAIM,
    verb: "see",
    ...overrides,
  };
}

function encodeSlhp(
  channel: string,
  attestation: Uint8Array,
  shareToken?: string,
): Uint8Array {
  const enc = new TextEncoder();
  const channelBytes = enc.encode(channel);
  const tokenBytes = shareToken !== undefined ? enc.encode(shareToken) : undefined;
  const payloadLen =
    4 +
    channelBytes.length +
    4 +
    attestation.length +
    1 +
    (tokenBytes ? 4 + tokenBytes.length : 0);
  const out = new Uint8Array(10 + payloadLen);
  const view = new DataView(out.buffer);
  out.set(enc.encode("SLHP"), 0);
  view.setUint16(4, 1, true);
  view.setUint32(6, payloadLen, true);
  let offset = 10;
  view.setUint32(offset, channelBytes.length, true);
  offset += 4;
  out.set(channelBytes, offset);
  offset += channelBytes.length;
  view.setUint32(offset, attestation.length, true);
  offset += 4;
  out.set(attestation, offset);
  offset += attestation.length;
  if (tokenBytes) {
    out[offset] = 1;
    offset += 1;
    view.setUint32(offset, tokenBytes.length, true);
    offset += 4;
    out.set(tokenBytes, offset);
  } else {
    out[offset] = 0;
  }
  return out;
}

describe("consume contract artifact", () => {
  it("covers light Check names and stays off the other plane", () => {
    const dts = readFileSync(join(HERE, "../../docs/s3rch-check.d.ts"), "utf8");
    for (const needle of [
      "CHECK(see, object, accessor)",
      "GunFeedNode",
      "GunChatNode",
      "GunPresenceNode",
      "GunUserNode",
      "IdentitySeeGrant",
      "HandoffHint",
      "UrlLeaf",
      "encodeKey",
      "s3rch/items",
      "s3rch/rooms",
      "s3rch/users",
      "s3rch/granted",
      "s3rch/meta",
      "checkSee",
      "checkSeeGrant",
      "acceptHint",
      "admitFeedNode",
      "admitRoomNode",
      "admitChatNode",
      "admitPresenceNode",
      "admitUserNode",
      "grantedSoul",
      "cancelSee",
      "hopcap",
      "s3rch/acl",
      "MeshSeeGrant",
      "HopFactor",
      "HeldClaimPrefix",
      "aclKey",
      "grantSoul",
      "acceptHop",
      "decodeHop",
    ]) {
      assert.match(dts, new RegExp(needle.replace(/[()]/g, "\\$&")));
    }
    const lower = dts.toLowerCase();
    for (const banned of [
      "elect",
      "will",
      "remint",
      "discover",
      "destroy",
      "case c",
      "napi",
      "wasm",
      "npm install",
      "sea",
      "encrypt",
      "checkexecute",
    ]) {
      assert.equal(lower.includes(banned), false, `contract must not mention ${banned}`);
    }
  });

  it("says the Next app runs Check in the browser, not a package", () => {
    const md = readFileSync(join(HERE, "../../docs/s3rch-check.md"), "utf8");
    const lower = md.toLowerCase();
    assert.match(md, /s3rch-check\.d\.ts/);
    assert.match(lower, /browser/);
    assert.equal(
      lower.includes("do not `npm install sociacl`") || lower.includes("do not npm install"),
      true,
    );
    assert.match(lower, /wasm later is optional/);
    assert.match(lower, /later, on request/);
    for (const banned of ["remint", "discover", "elect", "destroy", "sea"]) {
      assert.equal(lower.includes(banned), false, `consume doc must not name ${banned}`);
    }
  });
});

describe("locked Gun souls", () => {
  it("encodeKey and itemSoul match s3r.ch", () => {
    assert.equal(encodeKey("rss3:act/1#x"), "rss3:act/1_x");
    assert.equal(encodeKey("a.b#$[c]"), "a_b___c_");
    assert.equal(itemSoul("rss3:act/1#x"), "s3rch/items/rss3:act/1_x");
    assert.equal(roomSoul("s3rch:room:0xabc:1:aa"), "s3rch/rooms/s3rch:room:0xabc:1:aa");
    assert.equal(
      chatSoul("s3rch:room:0xabc:1:aa", "s3rch:chat:0xabc:1:bb"),
      "s3rch/rooms/s3rch:room:0xabc:1:aa/chat/s3rch:chat:0xabc:1:bb",
    );
    assert.equal(
      presenceSoul("s3rch:room:0xabc:1:aa", ALICE),
      `s3rch/rooms/s3rch:room:0xabc:1:aa/presence/${ALICE}`,
    );
    assert.equal(userSoul(ALICE), `s3rch/users/${ALICE}`);
    assert.equal(
      grantedSoul(BOB, "items", "s3rch:post:1"),
      `s3rch/granted/${BOB}/items/s3rch:post:1`,
    );
    assert.equal(metaSoul(), "s3rch/meta");
    assert.equal(aclKey("rss3:act/1#x"), "rss3:act_1_x");
    assert.equal(aclKey("ens:alice.eth"), "ens:alice_eth");
    assert.equal(aclKey(itemSoul("rss3:act/1#x")), "s3rch_items_rss3:act_1_x");
    assert.equal(aclPrincipalKey(userSoul(ALICE)), ALICE);
    assert.equal(aclPrincipalKey(ALICE.toLowerCase()), ALICE);
    assert.equal(aclSoul(ALICE), `s3rch/acl/${ALICE}`);
    assert.equal(
      grantSoul(ALICE, "rss3:act/1#x", BOB),
      `s3rch/acl/${ALICE}/rss3:act_1_x/${BOB}`,
    );
    assert.equal(
      grantSoul(ALICE, "ens:alice.eth", userSoul(BOB)),
      `s3rch/acl/${ALICE}/ens:alice_eth/${BOB}`,
    );
    assert.equal(
      grantSoul(ALICE, itemSoul("rss3:act/1#x"), BOB).split("/").length,
      5,
    );
  });

  it("toGunNode / fromGunNode: empty kind is activity; unknown source is not a feed node", () => {
    const node = toGunNode(sampleItem());
    assert.equal(node.tags, "Social,farcaster,social");
    const blank: GunFeedNode = { ...node, kind: "  " };
    assert.equal(fromGunNode(blank)?.kind, "activity");
    assert.equal(fromGunNode({ ...node, source: "kyc" }), null);
  });
});

describe("CHECK(see, object, accessor) consume laws", () => {
  it("owner is allowed", () => {
    const acl = createMemorySeeAcl();
    acl.putObject(CLAIM, ALICE);
    const result = checkSee(acl, CLAIM, ALICE, NOW);
    assert.equal(result.allowed, true);
    assert.equal(result.reason, "owner");
    assert.equal(checkSee(acl, CLAIM, userSoul(ALICE), NOW).allowed, true);
  });

  it("missing grant is denied", () => {
    const acl = createMemorySeeAcl();
    acl.putObject(CLAIM, ALICE);
    const result = checkSee(acl, CLAIM, BOB, NOW, hint());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "missing-grant");
  });

  it("expired until is denied", () => {
    const acl = createMemorySeeAcl();
    acl.putObject(CLAIM, ALICE);
    applySeeGrant(acl, ALICE, { claimId: CLAIM, accessor: BOB, from: 0, until: 50 });
    assert.equal(checkSee(acl, CLAIM, BOB, 49).allowed, true);
    const expired = checkSee(acl, CLAIM, BOB, 50);
    assert.equal(expired.allowed, false);
    assert.equal(expired.reason, "expired");
    assert.equal(acl.ownerOf(CLAIM), ALICE);
  });

  it("future from is denied", () => {
    const acl = createMemorySeeAcl();
    acl.putObject(CLAIM, ALICE);
    const grant = { claimId: CLAIM, accessor: BOB, from: 40, until: 80 };
    applySeeGrant(acl, ALICE, grant);
    const early = checkSee(acl, CLAIM, BOB, 10);
    assert.equal(early.allowed, false);
    assert.equal(early.reason, "future-from");
    assert.equal(checkSeeGrant(acl, grant, CLAIM, BOB, 10).allowed, false);
    assert.equal(checkSeeGrant(acl, grant, CLAIM, BOB, 10).reason, "future-from");
    assert.equal(checkSee(acl, CLAIM, BOB, 40).allowed, true);
    assert.equal(checkSeeGrant(acl, grant, CLAIM, BOB, 40).allowed, true);
    assert.equal(checkSeeGrant(acl, grant, CLAIM, BOB, 80).allowed, false);
  });

  it("hint does not allow", () => {
    const acl = createMemorySeeAcl();
    acl.putObject(CLAIM, ALICE);
    const accepted = acceptHint(hint({ context: "https://gi.rss3.io/decentralized/0xalice" }));
    assert.equal(accepted.principal, BOB);
    const result = checkSee(acl, CLAIM, BOB, NOW, accepted);
    assert.equal(result.allowed, false);
    assert.notEqual(result.reason, "see-grant");
  });

  it("hop missing does not fail; hop alone never allows; hint+hop fail closed without dest ACL", () => {
    const acl = createMemorySeeAcl();
    acl.putObject(CLAIM, ALICE);
    const hop: HopFactor = { channel: "convention-badge" };
    const acceptedHop = acceptHop(hop);
    assert.equal(acceptedHop instanceof Uint8Array ? false : acceptedHop.channel, "convention-badge");
    assert.equal(checkSee(acl, CLAIM, ALICE, NOW).allowed, true);
    assert.equal(checkSee(acl, CLAIM, ALICE, NOW, undefined, hop).allowed, true);
    const hopAlone = checkSee(acl, CLAIM, BOB, NOW, undefined, hop);
    assert.equal(hopAlone.allowed, false);
    assert.equal(hopAlone.reason, "missing-grant");
    const hintPlusHop = checkSee(acl, CLAIM, BOB, NOW, hint(), hop);
    assert.equal(hintPlusHop.allowed, false);
    const empty = createMemorySeeAcl();
    assert.equal(checkSee(empty, CLAIM, BOB, NOW, hint(), hop).allowed, false);
    applySeeGrant(acl, ALICE, { claimId: CLAIM, accessor: BOB, from: 0, until: NOW + 80 });
    assert.equal(checkSee(acl, CLAIM, BOB, NOW, undefined, hop).allowed, true);
  });

  it("decodeHop does not verify or mint; unnamed bytes stay opaque", () => {
    const bytes = encodeSlhp("convention-badge", new Uint8Array([1, 2, 3]), "token");
    const decoded = decodeHop(bytes);
    assert.equal(decoded instanceof Uint8Array, false);
    if (decoded instanceof Uint8Array) throw new Error("expected structured hop");
    assert.equal(decoded.channel, "convention-badge");
    assert.deepEqual(Array.from(decoded.attestationBytes ?? []), [1, 2, 3]);
    assert.equal(decoded.shareToken, "token");
    const garbage = decodeHop(new Uint8Array([9, 9, 9]));
    assert.equal(garbage instanceof Uint8Array, true);
    const acl = createMemorySeeAcl();
    assert.equal(checkSee(acl, CLAIM, BOB, NOW, undefined, garbage).allowed, false);
  });

  it("dest ACL souls and claim-id objects fail closed without dest ACL", () => {
    const acl = createMemorySeeAcl();
    const hop: HopFactor = { channel: "enrolled-station" };
    assert.equal(checkSee(acl, aclSoul(ALICE), ALICE, NOW).allowed, false);
    assert.equal(checkSee(acl, aclSoul(ALICE), ALICE, NOW).reason, "acl");
    assert.equal(
      checkSee(acl, grantSoul(ALICE, CLAIM, BOB), BOB, NOW, hint(), hop).allowed,
      false,
    );
    assert.equal(checkSee(acl, "s3rch/acl", ALICE, NOW).reason, "acl");
    for (const claim of [
      "ens:alice.eth",
      "unstoppable:brad.x",
      "fc:dwr",
      "farcaster:dwr",
      "lens:vitalik",
      "rss3:0xabc",
    ]) {
      assert.equal(checkSee(acl, claim, BOB, NOW, hint(), hop).allowed, false);
      acl.putObject(claim, ALICE);
      assert.equal(checkSee(acl, claim, ALICE, NOW).reason, "owner");
      assert.equal(checkSee(acl, claim, BOB, NOW, hint(), hop).allowed, false);
      assert.equal(claim.includes("/claims/"), false);
    }
  });

  it("owner-only cancelSee; non-owner cannot privilege-down", () => {
    const acl = createMemorySeeAcl();
    acl.putObject(CLAIM, ALICE);
    applySeeGrant(acl, ALICE, { claimId: CLAIM, accessor: BOB, from: 0, until: 80 });
    cancelSee(acl, BOB, BOB, CLAIM);
    assert.equal(checkSee(acl, CLAIM, BOB, 10).allowed, true);
    cancelSee(acl, ALICE, BOB, CLAIM);
    assert.equal(checkSee(acl, CLAIM, BOB, 10).allowed, false);
  });

  it("cancelSee denies the next check (privilege-down is immediate)", () => {
    const acl = createMemorySeeAcl();
    acl.putObject(CLAIM, ALICE);
    applySeeGrant(acl, ALICE, { claimId: CLAIM, accessor: BOB, from: 0, until: 80 });
    assert.equal(checkSee(acl, CLAIM, BOB, 10).allowed, true);
    cancelSee(acl, ALICE, BOB, CLAIM);
    const next = checkSee(acl, CLAIM, BOB, 10);
    assert.equal(next.allowed, false);
    assert.equal(next.reason, "missing-grant");
  });

  it("hopcap 1: a friend edge is not a see grant", () => {
    const friends: Array<[string, string]> = [
      [ALICE, BOB],
      [BOB, CAROL],
    ];
    const graph: SeeGraph & { friends: Array<[string, string]> } = {
      friends,
      hasObject: (object) => object === CLAIM,
      ownerOf: (object) => (object === CLAIM ? ALICE : undefined),
      seeGrants: () => [],
    };
    assert.equal(checkSee(graph, CLAIM, ALICE, NOW).allowed, true);
    assert.equal(checkSee(graph, CLAIM, BOB, NOW).allowed, false);
    assert.equal(checkSee(graph, CLAIM, CAROL, NOW).allowed, false);
    assert.equal(graph.friends.length, 2);
  });

  it("UrlLeaf and meta fail closed", () => {
    const acl = createMemorySeeAcl();
    acl.putObject(CLAIM, ALICE);
    acl.putObject(metaSoul(), ALICE);
    assert.equal(checkSee(acl, "https://gi.rss3.io/decentralized/0xalice", BOB, NOW).allowed, false);
    assert.equal(checkSee(acl, "https://gi.rss3.io/decentralized/0xalice", BOB, NOW).reason, "url-leaf");
    assert.equal(checkSee(acl, metaSoul(), ALICE, NOW).allowed, false);
    assert.equal(checkSee(acl, metaSoul(), ALICE, NOW).reason, "meta");
    assert.equal(checkSee(acl, "s3rch/meta", ALICE, NOW, hint({ target: "s3rch/meta" })).allowed, false);
  });

  it("admitFeedNode requires dest re-auth; hint / URL fetch is not authorization", () => {
    const acl = createMemorySeeAcl();
    const node = toGunNode(sampleItem());
    const urlHint = hint({
      context: "https://gi.rss3.io/decentralized/0xalice",
      target: itemSoul(node.id),
    });
    const garbage = admitFeedNode(
      acl,
      { ...node, id: "", source: "kyc" },
      ALICE,
      urlHint,
    );
    assert.deepEqual(garbage, { denied: true });
    assert.equal(acl.hasObject(itemSoul(node.id)), false);

    const admitted = admitFeedNode(acl, node, ALICE, urlHint);
    assert.deepEqual(admitted, { object: itemSoul(node.id) });
    assert.equal(checkSee(acl, itemSoul(node.id), ALICE, NOW).allowed, true);
    assert.equal(checkSee(acl, itemSoul(node.id), BOB, NOW, urlHint).allowed, false);
  });

  it("admitRoomNode requires dest re-auth; hint / URL fetch is not authorization", () => {
    const acl = createMemorySeeAcl();
    const node = {
      id: `s3rch:room:${ALICE}:${NOW}:aa`,
      title: "Lab",
      owner: ALICE,
      tags: "room,s3rch",
      ts: NOW,
      provenance: `s3rch:room:${ALICE}`,
    };
    const urlHint = hint({
      context: "https://example.com/room",
      target: roomSoul(node.id),
    });
    const garbage = admitRoomNode(acl, { ...node, id: "", title: "" }, ALICE, urlHint);
    assert.deepEqual(garbage, { denied: true });
    assert.equal(acl.hasObject(roomSoul(node.id)), false);

    const admitted = admitRoomNode(acl, node, ALICE, urlHint);
    assert.deepEqual(admitted, { object: roomSoul(node.id) });
    assert.equal(checkSee(acl, roomSoul(node.id), ALICE, NOW).allowed, true);
    assert.equal(checkSee(acl, roomSoul(node.id), BOB, NOW, urlHint).allowed, false);
  });

  it("admitChatNode requires dest re-auth; unknown v fails closed", () => {
    const acl = createMemorySeeAcl();
    const node = {
      id: `s3rch:chat:${ALICE}:${NOW}:aa`,
      room: `s3rch:room:${ALICE}:${NOW}:aa`,
      author: ALICE,
      body: "ping",
      ts: NOW,
    };
    const urlHint = hint({
      context: "https://example.com/chat",
      target: chatSoul(node.room, node.id),
    });
    const garbage = admitChatNode(acl, { ...node, id: "", body: "" }, ALICE, urlHint);
    assert.deepEqual(garbage, { denied: true });
    assert.equal(acl.hasObject(chatSoul(node.room, node.id)), false);

    const future = admitChatNode(acl, { ...node, v: 2 }, ALICE, urlHint);
    assert.deepEqual(future, { denied: true });
    assert.equal(acl.hasObject(chatSoul(node.room, node.id)), false);

    const admitted = admitChatNode(acl, node, ALICE, urlHint);
    assert.deepEqual(admitted, { object: chatSoul(node.room, node.id) });
    assert.equal(checkSee(acl, chatSoul(node.room, node.id), ALICE, NOW).allowed, true);
    assert.equal(checkSee(acl, chatSoul(node.room, node.id), BOB, NOW, urlHint).allowed, false);
  });

  it("admitPresenceNode requires dest re-auth; unknown v fails closed", () => {
    const acl = createMemorySeeAcl();
    const node = {
      room: `s3rch:room:${ALICE}:${NOW}:aa`,
      address: ALICE,
      ts: NOW,
    };
    const urlHint = hint({
      context: "https://example.com/presence",
      target: presenceSoul(node.room, node.address),
    });
    const garbage = admitPresenceNode(
      acl,
      { ...node, room: "", address: "" },
      ALICE,
      urlHint,
    );
    assert.deepEqual(garbage, { denied: true });
    assert.equal(acl.hasObject(presenceSoul(node.room, node.address)), false);

    const future = admitPresenceNode(acl, { ...node, v: 2 }, ALICE, urlHint);
    assert.deepEqual(future, { denied: true });
    assert.equal(acl.hasObject(presenceSoul(node.room, node.address)), false);

    const other = admitPresenceNode(acl, { ...node, address: BOB }, ALICE, urlHint);
    assert.deepEqual(other, { denied: true });

    const admitted = admitPresenceNode(acl, node, ALICE, urlHint);
    assert.deepEqual(admitted, { object: presenceSoul(node.room, node.address) });
    assert.equal(
      checkSee(acl, presenceSoul(node.room, node.address), ALICE, NOW).allowed,
      true,
    );
    assert.equal(
      checkSee(acl, presenceSoul(node.room, node.address), BOB, NOW, urlHint).allowed,
      false,
    );
  });

  it("admitUserNode requires dest re-auth; unknown v and secrets fail closed", () => {
    const acl = createMemorySeeAcl();
    const node = {
      id: ALICE,
      indicators: "ens:vitalik.eth,farcaster:dwr",
      provenance: `s3rch:user:${ALICE}`,
      ts: NOW,
    };
    const urlHint = hint({
      context: "https://example.com/user",
      target: userSoul(ALICE),
    });
    const garbage = admitUserNode(acl, { ...node, id: "" }, ALICE, urlHint);
    assert.deepEqual(garbage, { denied: true });
    assert.equal(acl.hasObject(userSoul(ALICE)), false);

    const future = admitUserNode(acl, { ...node, v: 2 }, ALICE, urlHint);
    assert.deepEqual(future, { denied: true });

    const tombstone = admitUserNode(acl, { ...node, unshared: 1 }, ALICE, urlHint);
    assert.deepEqual(tombstone, { denied: true });

    const secret = admitUserNode(
      acl,
      { ...node, priv: "nope" } as typeof node & { priv: string },
      ALICE,
      urlHint,
    );
    assert.deepEqual(secret, { denied: true });

    const other = admitUserNode(acl, { ...node, id: BOB }, ALICE, urlHint);
    assert.deepEqual(other, { denied: true });

    const admitted = admitUserNode(acl, node, ALICE, urlHint);
    assert.deepEqual(admitted, { object: userSoul(ALICE) });
    assert.equal(checkSee(acl, userSoul(ALICE), ALICE, NOW).allowed, true);
    assert.equal(checkSee(acl, CLAIM, ALICE, NOW).allowed, true);
    assert.equal(checkSee(acl, userSoul(ALICE), BOB, NOW, urlHint).allowed, false);
    assert.equal(checkSee(acl, CLAIM, BOB, NOW, urlHint).allowed, false);
  });

  it("live IdentitySeeGrant names the pair and now ∈ [from, until)", () => {
    const acl = createMemorySeeAcl();
    acl.putObject(CLAIM, ALICE);
    const grant = { claimId: CLAIM, accessor: BOB, from: 0, until: 80 };
    applySeeGrant(acl, ALICE, grant);
    assert.equal(grantLiveAt(grant, 0), true);
    assert.equal(grantLiveAt(grant, 80), false);
    assert.equal(checkSee(acl, CLAIM, BOB, 0).allowed, true);
    assert.equal(checkSeeGrant(acl, grant, CLAIM, userSoul(BOB), 0).allowed, true);
    assert.equal(checkSee(acl, CLAIM, BOB, 80).allowed, false);
  });
});
