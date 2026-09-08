import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fromGunNode,
  isUnsharePut,
  toUnshareTombstone,
  unshareIdOf,
  UNSHARE_MARKER,
} from "./feed-types";
import { dropFeedItems, itemUnshareTombstone, soulKeyMatches } from "./unshare";

const ID = "s3rch:post:0xabc:1:aa";

describe("HAM unshare marker", () => {
  it("treats null put and unshared: 1 as retract; ignores undefined", () => {
    assert.equal(isUnsharePut(null), true);
    assert.equal(isUnsharePut(undefined), false);
    assert.equal(isUnsharePut(toUnshareTombstone(ID, 10)), true);
    assert.equal(isUnsharePut({ id: ID, unshared: UNSHARE_MARKER, v: 1 }), true);
    assert.equal(isUnsharePut({ id: ID, unshared: null, source: "s3rch" }), false);
    assert.equal(isUnsharePut({ id: ID, source: "s3rch" }), false);
  });

  it("unknown future unshared values fail closed (drop)", () => {
    assert.equal(isUnsharePut({ id: ID, unshared: 2, v: 1 }), true);
    assert.equal(fromGunNode({ id: ID, unshared: 2, source: "s3rch", kind: "post", tags: "" }), null);
  });

  it("unknown future v on a tombstone still drops", () => {
    assert.equal(fromGunNode({ id: ID, unshared: 1, v: 2, source: "s3rch", kind: "post", tags: "" }), null);
  });

  it("fromGunNode drops a tombstone that still has leftover share fields", () => {
    const tomb = itemUnshareTombstone(ID, 11);
    assert.equal(tomb.unshared, 1);
    assert.equal(tomb.body, null);
    assert.equal(fromGunNode({ ...tomb, source: "s3rch", kind: "post", body: "old", tags: "user" }), null);
  });

  it("unshareIdOf prefers node id, then the Gun key", () => {
    assert.equal(unshareIdOf({ id: ID, unshared: 1 }, "other"), ID);
    assert.equal(unshareIdOf(null, "gun-key"), "gun-key");
    assert.equal(unshareIdOf(undefined), null);
  });

  it("dropFeedItems matches raw id or encodeKey", () => {
    const item = {
      id: ID,
      source: "s3rch" as const,
      kind: "post",
      author: "0xabc",
      body: "x",
      ts: 1,
      permalink: "",
      tags: ["user"],
      provenance: "s3rch:native:0xabc",
    };
    assert.equal(dropFeedItems([item], ID).length, 0);
    assert.equal(dropFeedItems([item], ID.replace(/[.#$[\]]/g, "_")).length, 0);
    assert.equal(dropFeedItems([item], "nope").length, 1);
    assert.equal(soulKeyMatches(ID, ID), true);
  });
});
