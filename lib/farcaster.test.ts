import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromGunNode, toGunNode } from "./feed-types";
import {
  FARCASTER_EPOCH_UNIX,
  castPermalink,
  farcasterTsToUnix,
  normalizeHubCast,
  usernameFromUserData,
} from "./farcaster";

describe("farcasterTsToUnix", () => {
  it("adds the Farcaster epoch for hub seconds", () => {
    // fid=2 cast 0x532064659e980a9a4c3614f2b1deb3ac63e8cc9a (probed 2026-09-01)
    assert.equal(farcasterTsToUnix(156796112), 1_766_255_312);
    assert.equal(FARCASTER_EPOCH_UNIX, 1_609_459_200);
  });

  it("passes through values that already look like unix seconds", () => {
    assert.equal(farcasterTsToUnix(1_766_255_312), 1_766_255_312);
  });

  it("returns 0 for junk", () => {
    assert.equal(farcasterTsToUnix(0), 0);
    assert.equal(farcasterTsToUnix(Number.NaN), 0);
  });
});

describe("normalizeHubCast", () => {
  it("maps a CAST_ADD into a tagged Gun item", () => {
    const item = normalizeHubCast(
      {
        hash: "0x532064659e980a9a4c3614f2b1deb3ac63e8cc9a",
        data: {
          type: "MESSAGE_TYPE_CAST_ADD",
          fid: 2,
          timestamp: 156796112,
          castAddBody: { text: "Everyone at Farcaster eventually becomes a React Native engineer" },
        },
      },
      "v",
      "farcaster:hub:https://hub.pinata.cloud/v1/castsByFid?fid=2",
    );
    assert.ok(item);
    assert.equal(item.source, "farcaster");
    assert.equal(item.kind, "social");
    assert.equal(item.author, "v");
    assert.equal(item.ts, 1_766_255_312);
    assert.equal(
      item.permalink,
      "https://farcaster.xyz/v/0x532064659e980a9a4c3614f2b1deb3ac63e8cc9a",
    );
    assert.deepEqual(item.tags, ["farcaster", "social"]);
    assert.match(item.provenance, /^farcaster:hub:/);
  });

  it("skips non-cast messages and missing hashes", () => {
    assert.equal(
      normalizeHubCast(
        { hash: "0xabc", data: { type: "MESSAGE_TYPE_REACTION_ADD", timestamp: 1 } },
        "v",
        "farcaster:hub:test",
      ),
      null,
    );
    assert.equal(
      normalizeHubCast(
        { data: { type: "MESSAGE_TYPE_CAST_ADD", fid: 1, timestamp: 1, castAddBody: { text: "x" } } },
        null,
        "farcaster:hub:test",
      ),
      null,
    );
  });

  it("falls back to fid:N when username is missing", () => {
    const item = normalizeHubCast(
      {
        hash: "0xabc",
        data: {
          type: "MESSAGE_TYPE_CAST_ADD",
          fid: 1,
          timestamp: 10,
          castAddBody: { text: "hello" },
        },
      },
      null,
      "farcaster:hub:test",
    );
    assert.equal(item?.author, "fid:1");
    assert.equal(item?.permalink, "https://farcaster.xyz/~/conversations/0xabc");
  });
});

describe("usernameFromUserData", () => {
  it("reads USER_DATA_TYPE_USERNAME", () => {
    assert.equal(
      usernameFromUserData({
        messages: [
          { data: { userDataBody: { type: "USER_DATA_TYPE_DISPLAY", value: "Varun" } } },
          { data: { userDataBody: { type: "USER_DATA_TYPE_USERNAME", value: "v" } } },
        ],
      }),
      "v",
    );
  });
});

describe("castPermalink", () => {
  it("prefixes 0x when missing", () => {
    assert.equal(castPermalink("farcaster", "ffd7"), "https://farcaster.xyz/farcaster/0xffd7");
  });
});

describe("fromGunNode farcaster", () => {
  it("survives a Gun round-trip", () => {
    const item = normalizeHubCast(
      {
        hash: "0xabc",
        data: {
          type: "MESSAGE_TYPE_CAST_ADD",
          fid: 3,
          timestamp: 20,
          castAddBody: { text: "gm" },
        },
      },
      "dwr",
      "farcaster:hub:test",
    );
    assert.ok(item);
    const recovered = fromGunNode(toGunNode(item));
    assert.deepEqual(recovered, item);
  });
});
