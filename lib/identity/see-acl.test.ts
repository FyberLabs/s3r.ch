import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySeeGrant, cancelSee, checkSee } from "./check";
import {
  createMemorySeeAcl,
  grantsOwnedBy,
  isIdentitySeeGrant,
  sanitizeSeeAclSnapshot,
} from "./see-acl";
import { heldClaimOptions, parseGrantAccessor, grantWindowFromHours } from "./held-claims";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CLAIM = "ens:vitalik.eth";

describe("SeeAcl dest store", () => {
  it("snapshots IdentitySeeGrant records only — no SIWE / SEA / wrap / paper", () => {
    const acl = createMemorySeeAcl();
    acl.putObject(CLAIM, ALICE);
    applySeeGrant(acl, ALICE, { claimId: CLAIM, accessor: BOB, from: 0, until: 80 });
    const snap = acl.snapshot();
    const json = JSON.stringify(snap);
    assert.equal(json.includes("priv"), false);
    assert.equal(json.includes("epriv"), false);
    assert.equal(json.includes("seaPair"), false);
    assert.equal(json.includes("wrap"), false);
    assert.equal(json.includes("paper"), false);
    assert.equal(json.includes("siwe"), false);
    assert.equal(json.includes("walletSignature"), false);
    assert.equal(snap.grants.length, 1);
    assert.deepEqual(snap.grants[0], {
      claimId: CLAIM,
      accessor: BOB,
      from: 0,
      until: 80,
    });
  });

  it("rejects secret-bearing rows as grants", () => {
    assert.equal(isIdentitySeeGrant({ claimId: CLAIM, accessor: BOB, from: 0, until: 1 }), true);
    assert.equal(
      isIdentitySeeGrant({
        claimId: CLAIM,
        accessor: BOB,
        from: 0,
        until: 1,
        priv: "sea-priv",
      }),
      false,
    );
    const dirty = sanitizeSeeAclSnapshot({
      priv: "nope",
      objects: [{ object: CLAIM, owner: ALICE }],
      grants: [{ claimId: CLAIM, accessor: BOB, from: 0, until: 1 }],
    });
    assert.deepEqual(dirty, { objects: [], grants: [] });
  });

  it("lists grants owned by the holder and drops them on cancelSee", () => {
    const acl = createMemorySeeAcl();
    acl.putObject(CLAIM, ALICE);
    applySeeGrant(acl, ALICE, { claimId: CLAIM, accessor: BOB, from: 0, until: 80 });
    assert.equal(grantsOwnedBy(acl, ALICE).length, 1);
    cancelSee(acl, ALICE, BOB, CLAIM);
    assert.equal(grantsOwnedBy(acl, ALICE).length, 0);
    assert.equal(checkSee(acl, CLAIM, BOB, 10).allowed, false);
  });
});

describe("held claim ids and grant form", () => {
  it("uses the claim id, not s3rch/users/{wallet}/claims/…", () => {
    const options = heldClaimOptions({
      address: ALICE.toLowerCase(),
      ens: "vitalik.eth",
      unstoppable: "brad.x",
      farcaster: "dwr",
      lens: "vitalik",
      rss3: "footprint",
    });
    assert.deepEqual(
      options.map((option) => option.id),
      [
        ALICE,
        "ens:vitalik.eth",
        "unstoppable:brad.x",
        "farcaster:dwr",
        "lens:vitalik",
        "rss3:footprint",
      ],
    );
    for (const option of options) {
      assert.equal(option.id.includes("/claims/"), false);
    }
  });

  it("requires a checksummed accessor and a positive window", () => {
    assert.equal(parseGrantAccessor(BOB.toLowerCase()), BOB);
    assert.equal(parseGrantAccessor("not-an-address"), null);
    assert.deepEqual(grantWindowFromHours(1, 100), { from: 100, until: 3700 });
    assert.equal(grantWindowFromHours(0, 100), null);
  });
});
