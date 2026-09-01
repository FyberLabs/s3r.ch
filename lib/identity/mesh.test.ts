import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryMeshKeyStore } from "./idb";
import { ensureLocalMeshKey } from "./mesh";
import type { SeaPair } from "./sea";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function fakePair(pub: string): SeaPair {
  return { pub, priv: `priv-${pub}`, epub: `epub-${pub}`, epriv: `epriv-${pub}` };
}

describe("ensureLocalMeshKey", () => {
  it("mints a pair, signs a domain-bound link, and persists it", async () => {
    const store = createMemoryMeshKeyStore();
    let minted = 0;
    const signed: string[] = [];
    const result = await ensureLocalMeshKey({
      address: ADDRESS.toLowerCase(),
      domain: "localhost:3000",
      uri: "http://localhost:3000",
      createPair: async () => {
        minted += 1;
        return fakePair("first-pub");
      },
      signMessage: async (message) => {
        signed.push(message);
        return "0xwallet-sig";
      },
      store,
    });

    assert.equal(result.created, true);
    assert.equal(result.record.address, ADDRESS);
    assert.equal(result.record.seaPub, "first-pub");
    assert.equal(result.record.walletSignature, "0xwallet-sig");
    assert.match(result.record.signedPayload, /SEA pub: first-pub/);
    assert.match(result.record.signedPayload, /Address: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266/);
    assert.equal(minted, 1);
    assert.equal(signed.length, 1);
    assert.doesNotMatch(signed[0] ?? "", /priv-first-pub/);
  });

  it("reuses an existing pair and does not mint or re-sign", async () => {
    const store = createMemoryMeshKeyStore();
    let minted = 0;
    let signed = 0;
    const createPair = async () => {
      minted += 1;
      return fakePair(`pub-${minted}`);
    };
    const signMessage = async () => {
      signed += 1;
      return `0xsig-${signed}`;
    };
    const input = {
      address: ADDRESS,
      domain: "s3r.ch" as const,
      uri: "https://s3r.ch",
      createPair,
      signMessage,
      store,
    };

    const first = await ensureLocalMeshKey(input);
    const second = await ensureLocalMeshKey({
      ...input,
      address: ADDRESS.toLowerCase(),
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.record.seaPub, first.record.seaPub);
    assert.equal(second.record.seaPair.priv, first.record.seaPair.priv);
    assert.equal(second.record.walletSignature, first.record.walletSignature);
    assert.equal(minted, 1);
    assert.equal(signed, 1);
  });

  it("keeps a different pair per checksummed address", async () => {
    const store = createMemoryMeshKeyStore();
    let minted = 0;
    const resultA = await ensureLocalMeshKey({
      address: ADDRESS,
      domain: "localhost:3000",
      uri: "http://localhost:3000",
      createPair: async () => {
        minted += 1;
        return fakePair("pub-a");
      },
      signMessage: async () => "0x-a",
      store,
    });
    const resultB = await ensureLocalMeshKey({
      address: OTHER,
      domain: "localhost:3000",
      uri: "http://localhost:3000",
      createPair: async () => {
        minted += 1;
        return fakePair("pub-b");
      },
      signMessage: async () => "0x-b",
      store,
    });

    assert.equal(resultA.record.seaPub, "pub-a");
    assert.equal(resultB.record.seaPub, "pub-b");
    assert.equal(minted, 2);
    assert.equal((await store.get(ADDRESS))?.seaPub, "pub-a");
  });

  it("does not delete the pair on sign-out (device key stays)", async () => {
    const store = createMemoryMeshKeyStore();
    await ensureLocalMeshKey({
      address: ADDRESS,
      domain: "localhost:3000",
      uri: "http://localhost:3000",
      createPair: async () => fakePair("stays"),
      signMessage: async () => "0xstay",
      store,
    });

    // Sign-out clears the cookie session only. IndexedDB is not touched.
    const afterSignOut = await store.get(ADDRESS);
    assert.ok(afterSignOut);
    assert.equal(afterSignOut.seaPub, "stays");

    const again = await ensureLocalMeshKey({
      address: ADDRESS,
      domain: "localhost:3000",
      uri: "http://localhost:3000",
      createPair: async () => fakePair("must-not-mint"),
      signMessage: async () => "0xmust-not-sign",
      store,
    });
    assert.equal(again.created, false);
    assert.equal(again.record.seaPub, "stays");
  });
});
