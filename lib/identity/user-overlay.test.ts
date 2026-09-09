import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleMineUser, toGunUserNode } from "../users";
import {
  createMemoryUserOverlayStore,
  overlayRecordToUser,
  userToOverlayRecord,
} from "./user-overlay";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NOW = 1_700_000_000;

describe("Mine overlay GunUserNode store", () => {
  it("round-trips an assembled overlay and rejects secrets", () => {
    const overlay = assembleMineUser({
      address: ALICE,
      lookups: { ens: "vitalik.eth" },
      nowSeconds: NOW,
    });
    assert.ok(overlay);
    const record = userToOverlayRecord(overlay);
    assert.equal(record.address, ALICE);
    assert.equal(record.indicators, "ens:vitalik.eth");
    assert.deepEqual(overlayRecordToUser(record), overlay);

    assert.equal(
      overlayRecordToUser({
        ...record,
        priv: "sea-priv",
      }),
      null,
    );
    assert.equal(
      overlayRecordToUser({
        ...record,
        siwe: "sig",
      }),
      null,
    );
    assert.equal(overlayRecordToUser({ ...record, id: "not-an-address" }), null);
  });

  it("memory store keeps linked claims without writing a public node", async () => {
    const store = createMemoryUserOverlayStore();
    const first = assembleMineUser({
      address: ALICE,
      lookups: { ens: "vitalik.eth" },
      nowSeconds: NOW,
    });
    assert.ok(first);
    await store.put(first);
    const loaded = await store.get(ALICE.toLowerCase());
    assert.ok(loaded);
    assert.deepEqual(loaded.indicators, ["ens:vitalik.eth"]);

    const updated = assembleMineUser({
      address: ALICE,
      lookups: { ens: "vitalik.eth", farcaster: "dwr" },
      previous: loaded,
      nowSeconds: NOW + 1,
    });
    assert.ok(updated);
    await store.put(updated);
    const again = await store.get(ALICE);
    assert.ok(again);
    assert.deepEqual(again.indicators, ["ens:vitalik.eth", "farcaster:dwr"]);
    assert.equal(toGunUserNode(again).unshared, undefined);
  });

  it("keeps a private email claim on the overlay without a public put", async () => {
    const store = createMemoryUserOverlayStore();
    const first = assembleMineUser({
      address: ALICE,
      lookups: { email: "alice@example.com" },
      nowSeconds: NOW,
    });
    assert.ok(first);
    await store.put(first);
    const loaded = await store.get(ALICE);
    assert.ok(loaded);
    assert.deepEqual(loaded.indicators, ["email:alice@example.com"]);
    assert.equal(toGunUserNode(loaded).indicators.includes("/claims/"), false);
  });
});
