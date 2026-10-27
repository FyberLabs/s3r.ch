import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SeaPair } from "@/lib/identity/sea";
import vector from "@/lib/identity/vectors/forums.json";
import {
  forgetUnlockedMeshPair,
  readUnlockedMeshPair,
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
