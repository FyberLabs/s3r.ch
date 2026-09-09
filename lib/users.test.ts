import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applySeeGrant,
  checkSee,
  userSoul,
} from "./identity/check";
import { createMemorySeeAcl } from "./identity/see-acl";
import {
  admitComposedUser,
  assembleMineUser,
  claimIsShared,
  composeUser,
  fromGunUserNode,
  joinIndicators,
  linkHeldIndicators,
  mergeUsers,
  namedHeldIndicators,
  ownsUser,
  prepareShareClaimIntoMesh,
  prepareShareUserIntoMesh,
  prepareUnshareClaimFromMesh,
  prepareUnshareUserFromMesh,
  registerMineUserOverlay,
  splitIndicators,
  toGunUserNode,
  userProvenanceLine,
  type User,
} from "./users";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const NOW = 1_700_000_000;

function user(overrides: Partial<{ indicators: string[]; nowSeconds: number }> = {}): User {
  const built = composeUser({
    address: ALICE,
    indicators: overrides.indicators ?? ["ens:vitalik.eth", "farcaster:dwr"],
    nowSeconds: overrides.nowSeconds ?? NOW,
  });
  assert.ok(built);
  return built;
}

describe("GunUserNode csv indicators", () => {
  it("toGunUserNode / fromGunUserNode round-trip", () => {
    const built = composeUser({
      address: ALICE.toLowerCase(),
      indicators: ["ens:vitalik.eth", " ENS:vitalik.eth ", "farcaster:dwr"],
      nowSeconds: NOW,
    });
    assert.ok(built);
    assert.equal(built.id, ALICE);
    assert.deepEqual(built.indicators, ["ens:vitalik.eth", "farcaster:dwr"]);
    assert.equal(built.provenance, `s3rch:user:${ALICE}`);
    assert.equal(built.v, 1);
    const node = toGunUserNode(built);
    assert.equal(node.indicators, "ens:vitalik.eth,farcaster:dwr");
    assert.equal(node.v, 1);
    const back = fromGunUserNode(node);
    assert.deepEqual(back, built);
    assert.equal(fromGunUserNode({ ...node, v: undefined })?.id, built.id);
    assert.equal(fromGunUserNode({ ...node, v: 2 }), null);
    assert.equal(fromGunUserNode({ ...node, unshared: 1 }), null);
    assert.equal(fromGunUserNode({ ...node, unshared: 2 }), null);
  });

  it("fromGunUserNode rejects a bad id, secrets, or empty id", () => {
    const built = user();
    const node = toGunUserNode(built);
    assert.equal(fromGunUserNode({ ...node, id: "not-an-address" }), null);
    assert.equal(fromGunUserNode({ ...node, id: "" }), null);
    assert.equal(fromGunUserNode({ ...node, priv: "sea-priv" } as typeof node), null);
    assert.equal(fromGunUserNode({ ...node, epriv: "sea-epriv" } as typeof node), null);
    assert.equal(fromGunUserNode({ ...node, siwe: "sig" } as typeof node), null);
  });

  it("splitIndicators preserves claim-id casing and accepts arrays", () => {
    assert.deepEqual(splitIndicators("ens:Name.eth, farcaster:dwr,ens:name.eth"), [
      "ens:Name.eth",
      "farcaster:dwr",
    ]);
    assert.deepEqual(splitIndicators(["lens:vitalik", "", "lens:vitalik"]), [
      "lens:vitalik",
    ]);
    assert.equal(joinIndicators(["ens:a.eth", "ens:a.eth"]), "ens:a.eth");
  });
});

describe("composeUser", () => {
  it("builds a valid user node", () => {
    const built = composeUser({
      address: ALICE.toLowerCase(),
      indicators: namedHeldIndicators({
        ens: "vitalik.eth",
        farcaster: "dwr",
        lens: "vitalik",
        rss3: "footprint",
        unstoppable: "brad.x",
      }),
      nowSeconds: NOW,
    });
    assert.ok(built);
    assert.equal(built.id, ALICE);
    assert.deepEqual(built.indicators, [
      "ens:vitalik.eth",
      "unstoppable:brad.x",
      "farcaster:dwr",
      "lens:vitalik",
      "rss3:footprint",
    ]);
    assert.equal(built.ts, NOW);
    assert.equal(built.v, 1);
    assert.equal(ownsUser(built, ALICE.toLowerCase()), true);
    assert.equal(ownsUser(built, BOB), false);
  });

  it("rejects a bad address and allows empty indicators", () => {
    assert.equal(composeUser({ address: "not-an-address" }), null);
    const empty = composeUser({ address: ALICE, nowSeconds: NOW });
    assert.ok(empty);
    assert.deepEqual(empty.indicators, []);
  });
});

describe("assemble / link Mine overlay", () => {
  it("assembles a Mine GunUserNode with linked claim ids after SIWE lookups", () => {
    const overlay = assembleMineUser({
      address: ALICE.toLowerCase(),
      lookups: {
        ens: "vitalik.eth",
        unstoppable: "brad.x",
        farcaster: "dwr",
        lens: "vitalik",
        rss3: "footprint",
      },
      nowSeconds: NOW,
    });
    assert.ok(overlay);
    assert.equal(overlay.id, ALICE);
    assert.deepEqual(overlay.indicators, [
      "ens:vitalik.eth",
      "unstoppable:brad.x",
      "farcaster:dwr",
      "lens:vitalik",
      "rss3:footprint",
    ]);
    const node = toGunUserNode(overlay);
    assert.equal(node.indicators.includes("ens:vitalik.eth"), true);
    assert.equal(node.v, 1);
  });

  it("pending lookups keep previous linked claims; settled empty drops that family", () => {
    const previous = user({
      indicators: ["ens:vitalik.eth", "farcaster:dwr"],
    });
    assert.deepEqual(
      linkHeldIndicators({ ens: undefined, farcaster: "alice" }, previous.indicators),
      ["ens:vitalik.eth", "farcaster:alice"],
    );
    const updated = assembleMineUser({
      address: ALICE,
      lookups: { ens: null, farcaster: undefined },
      previous,
      nowSeconds: NOW + 1,
    });
    assert.ok(updated);
    assert.deepEqual(updated.indicators, ["farcaster:dwr"]);
  });

  it("registerMineUserOverlay admits and links claims without a public share put", () => {
    const acl = createMemorySeeAcl();
    const overlay = assembleMineUser({
      address: ALICE,
      lookups: { ens: "vitalik.eth", farcaster: "dwr" },
      nowSeconds: NOW,
    });
    assert.ok(overlay);
    const registered = registerMineUserOverlay(acl, overlay, ALICE);
    assert.ok(!("denied" in registered));
    assert.equal(registered.object, userSoul(ALICE));
    assert.equal(registered.node.indicators, "ens:vitalik.eth,farcaster:dwr");
    assert.equal(acl.hasObject("ens:vitalik.eth"), true);
    assert.equal(acl.hasObject("farcaster:dwr"), true);

    const publicPut = prepareShareUserIntoMesh(acl, overlay, ALICE, []);
    assert.ok(!("denied" in publicPut));
    assert.equal(publicPut.node.indicators, "");
    assert.deepEqual(overlay.indicators, ["ens:vitalik.eth", "farcaster:dwr"]);
  });

  it("share / unshare claim paths require the claim to be Gun-linked on the overlay", () => {
    const acl = createMemorySeeAcl();
    const overlay = assembleMineUser({
      address: ALICE,
      lookups: { ens: "vitalik.eth" },
      nowSeconds: NOW,
    });
    assert.ok(overlay);
    registerMineUserOverlay(acl, overlay, ALICE);

    assert.deepEqual(
      prepareShareClaimIntoMesh(acl, overlay, ALICE, "lens:nope", []),
      { denied: true },
    );
    const share = prepareShareClaimIntoMesh(
      acl,
      overlay,
      ALICE,
      "ens:vitalik.eth",
      [],
      NOW + 1,
    );
    assert.ok(!("denied" in share));
    assert.equal(share.node.indicators, "ens:vitalik.eth");

    const unshare = prepareUnshareClaimFromMesh(
      acl,
      overlay,
      ALICE,
      "ens:vitalik.eth",
      ["ens:vitalik.eth"],
      NOW + 2,
    );
    assert.ok(!("denied" in unshare));
    assert.ok("node" in unshare);
    assert.equal(unshare.node.indicators, "");
    assert.deepEqual(
      prepareUnshareClaimFromMesh(acl, overlay, ALICE, "ens:vitalik.eth", []),
      { denied: true },
    );
  });
});

describe("admit before overlay / share", () => {
  it("admitUserNode is required before overlay register / share put", () => {
    const acl = createMemorySeeAcl();
    const built = user();
    const garbage = admitComposedUser(acl, { ...built, id: "" }, ALICE);
    assert.deepEqual(garbage, { denied: true });
    assert.equal(acl.hasObject(userSoul(built.id)), false);

    const registered = admitComposedUser(acl, built, ALICE);
    assert.ok(!("denied" in registered));
    assert.equal(registered.object, userSoul(built.id));
    assert.equal(acl.hasObject(userSoul(built.id)), true);
    assert.equal(acl.hasObject("ens:vitalik.eth"), true);

    const deniedShare = prepareShareUserIntoMesh(
      acl,
      { ...built, id: "not-an-address" },
      ALICE,
    );
    assert.deepEqual(deniedShare, { denied: true });

    const share = prepareShareUserIntoMesh(acl, built, ALICE, []);
    assert.ok(!("denied" in share));
    assert.equal(share.key, ALICE);
    assert.equal(share.node.id, ALICE);
    assert.equal(share.node.indicators, "");
    assert.equal(share.node.v, 1);
    assert.equal(share.node.unshared, null);
  });
});

describe("Mine-until-share held claims", () => {
  it("publishing the user node does not dump overlay indicators", () => {
    const acl = createMemorySeeAcl();
    const built = user();
    admitComposedUser(acl, built, ALICE);
    const share = prepareShareUserIntoMesh(acl, built, ALICE, []);
    assert.ok(!("denied" in share));
    assert.equal(share.node.indicators, "");
    const publicUser = fromGunUserNode(share.node);
    assert.ok(publicUser);
    assert.deepEqual(publicUser.indicators, []);
    assert.deepEqual(built.indicators, ["ens:vitalik.eth", "farcaster:dwr"]);
  });

  it("sharing one claim does not publish the others", () => {
    const acl = createMemorySeeAcl();
    const built = user();
    admitComposedUser(acl, built, ALICE);
    const share = prepareShareClaimIntoMesh(
      acl,
      built,
      ALICE,
      "ens:vitalik.eth",
      [],
      NOW + 1,
    );
    assert.ok(!("denied" in share));
    assert.equal(share.node.indicators, "ens:vitalik.eth");
    assert.equal(claimIsShared("ens:vitalik.eth", ["ens:vitalik.eth"]), true);
    assert.equal(claimIsShared("farcaster:dwr", ["ens:vitalik.eth"]), false);

    const denied = prepareShareClaimIntoMesh(acl, built, ALICE, "lens:nope", []);
    assert.deepEqual(denied, { denied: true });
  });

  it("sharing the wallet claim publishes the user node without a wallet indicator", () => {
    const acl = createMemorySeeAcl();
    const built = user({ indicators: ["ens:vitalik.eth"] });
    const share = prepareShareClaimIntoMesh(acl, built, ALICE, ALICE, []);
    assert.ok(!("denied" in share));
    assert.equal(share.node.indicators, "");
    assert.equal(share.key, ALICE);
  });

  it("applySeeGrant on a user or claim is not a public share", () => {
    const acl = createMemorySeeAcl();
    const built = user();
    admitComposedUser(acl, built, ALICE);
    applySeeGrant(acl, ALICE, {
      claimId: "ens:vitalik.eth",
      accessor: BOB,
      from: 0,
      until: NOW + 1,
    });
    applySeeGrant(acl, ALICE, {
      claimId: built.id,
      accessor: BOB,
      from: 0,
      until: NOW + 1,
    });
    assert.equal(checkSee(acl, "ens:vitalik.eth", BOB, NOW).allowed, true);
    assert.equal(checkSee(acl, userSoul(built.id), BOB, NOW).allowed, true);

    const publicPut = prepareShareUserIntoMesh(acl, built, ALICE, []);
    assert.ok(!("denied" in publicPut));
    assert.equal(publicPut.node.indicators, "");
  });

  it("unshare user node is a tombstone; unshare claim republishes without that indicator", () => {
    const acl = createMemorySeeAcl();
    const built = user();
    admitComposedUser(acl, built, ALICE);
    applySeeGrant(acl, ALICE, {
      claimId: "ens:vitalik.eth",
      accessor: BOB,
      from: 0,
      until: NOW + 1,
    });
    assert.equal(checkSee(acl, "ens:vitalik.eth", BOB, NOW).allowed, true);

    assert.deepEqual(prepareUnshareUserFromMesh(acl, built, BOB), { denied: true });
    const shared = prepareShareClaimIntoMesh(
      acl,
      built,
      ALICE,
      "ens:vitalik.eth",
      [],
      NOW + 1,
    );
    assert.ok(!("denied" in shared));
    const claimUnshare = prepareUnshareClaimFromMesh(
      acl,
      built,
      ALICE,
      "ens:vitalik.eth",
      ["ens:vitalik.eth"],
      NOW + 2,
    );
    assert.ok(!("denied" in claimUnshare));
    assert.ok("node" in claimUnshare);
    assert.equal(claimUnshare.node.indicators, "");
    assert.equal(claimUnshare.node.unshared, null);
    assert.equal(claimUnshare.node.ts, NOW + 2);
    assert.deepEqual(
      prepareUnshareClaimFromMesh(acl, built, ALICE, "farcaster:dwr", ["ens:vitalik.eth"]),
      { denied: true },
    );

    const nodeUnshare = prepareUnshareUserFromMesh(acl, built, ALICE, NOW + 3);
    assert.ok(!("denied" in nodeUnshare));
    assert.equal(nodeUnshare.tombstone.unshared, 1);
    assert.equal(fromGunUserNode(nodeUnshare.tombstone), null);
    assert.equal(checkSee(acl, "ens:vitalik.eth", BOB, NOW).allowed, true);
  });
});

describe("merge and provenance", () => {
  it("mergeUsers prefers newer ts for the same wallet", () => {
    const empty = user({ indicators: [], nowSeconds: NOW });
    const later = user({ indicators: ["ens:vitalik.eth"], nowSeconds: NOW + 5 });
    const merged = mergeUsers([empty], [later]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0]?.indicators, ["ens:vitalik.eth"]);
  });

  it("userProvenanceLine is truncated address plus indicators", () => {
    const built = user();
    assert.equal(
      userProvenanceLine(built),
      "0xf39F…2266 · ens:vitalik.eth, farcaster:dwr",
    );
    assert.equal(userProvenanceLine({ id: ALICE, indicators: [] }), "0xf39F…2266");
  });

  it("userSoul checksums a lowercase wallet", () => {
    assert.equal(userSoul(ALICE.toLowerCase()), `s3rch/users/${ALICE}`);
  });
});
