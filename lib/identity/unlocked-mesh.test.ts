import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SeaPair } from "@/lib/identity/sea";
import vector from "@/lib/identity/vectors/forums.json";
import {
  forgetUnlockedMeshPair,
  readUnlockedMeshPair,
  readSingleUnlockedIdentity,
  rememberUnlockedMeshPair,
  subscribeUnlockedMeshPair,
} from "@/lib/identity/unlocked-mesh";

const pair: SeaPair = {
  pub: vector.seaPubkey,
  priv: "priv-stays-in-page-memory",
  epub: "epub-value",
  epriv: "epriv-value",
};

describe("unlocked mesh pair", () => {
  it("remembers a pair for subscribers and forgets it without touching another address", () => {
    forgetUnlockedMeshPair();
    const heard: Array<SeaPair | null> = [];
    const stop = subscribeUnlockedMeshPair((address, next) => {
      if (address === "0xabc") heard.push(next);
    });
    assert.equal(readUnlockedMeshPair("0xAbC"), null);
    rememberUnlockedMeshPair("0xAbC", pair);
    assert.equal(readUnlockedMeshPair("0xabc"), pair);
    rememberUnlockedMeshPair("0xdef", { ...pair, pub: vector.secondPubkey });
    assert.equal(readUnlockedMeshPair("0xdef")?.pub, vector.secondPubkey);
    forgetUnlockedMeshPair("0xABC");
    assert.equal(readUnlockedMeshPair("0xabc"), null);
    assert.equal(readUnlockedMeshPair("0xdef")?.pub, vector.secondPubkey);
    assert.deepEqual(heard, [pair, null]);
    stop();
    forgetUnlockedMeshPair();
    assert.equal(readUnlockedMeshPair("0xdef"), null);
  });
});


it("site identity selection requires one unique unlocked SEA key and returns a snapshot", () => {
  forgetUnlockedMeshPair();
  assert.equal(readSingleUnlockedIdentity(), null);
  rememberUnlockedMeshPair("first", pair);
  const first = readSingleUnlockedIdentity(); assert.ok(first);
  assert.deepEqual(first.pair, pair); assert.notEqual(first.pair, pair);
  rememberUnlockedMeshPair("linked", pair);
  const linked = readSingleUnlockedIdentity(); assert.ok(linked);
  assert.equal(linked.pair.pub, pair.pub); assert.ok(linked.revision > first.revision);
  rememberUnlockedMeshPair("other", { ...pair, pub: vector.secondPubkey });
  assert.equal(readSingleUnlockedIdentity(), null);
  forgetUnlockedMeshPair("other");
  assert.equal(readSingleUnlockedIdentity()?.pair.pub, pair.pub);
  forgetUnlockedMeshPair(); assert.equal(readSingleUnlockedIdentity(), null);
});
