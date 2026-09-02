import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fromGunNode, toGunNode, type FeedItem, type GunFeedNode } from "@/lib/feed-types";
import {
  acceptHint,
  admitFeedNode,
  applySeeGrant,
  cancelSee,
  checkSee,
  checkSeeGrant,
  encodeKey,
  grantLiveAt,
  itemSoul,
  metaSoul,
  userSoul,
  type HandoffHint,
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

describe("consume contract artifact", () => {
  it("covers light Check names and stays off the other plane", () => {
    const dts = readFileSync(join(HERE, "../../docs/s3rch-check.d.ts"), "utf8");
    for (const needle of [
      "CHECK(see, object, accessor)",
      "GunFeedNode",
      "GunUserNode",
      "IdentitySeeGrant",
      "HandoffHint",
      "UrlLeaf",
      "encodeKey",
      "s3rch/items",
      "s3rch/users",
      "s3rch/meta",
      "checkSee",
      "checkSeeGrant",
      "acceptHint",
      "admitFeedNode",
      "cancelSee",
      "hopcap",
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
    assert.equal(userSoul(ALICE), `s3rch/users/${ALICE}`);
    assert.equal(metaSoul(), "s3rch/meta");
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
