import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createMemoryConfirmProofStore,
  isHeldConfirmProof,
  lookupsFromConfirmProofs,
  type HeldConfirmProof,
} from "./confirm-proof";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function proof(overrides: Partial<HeldConfirmProof> = {}): HeldConfirmProof {
  return {
    address: ALICE,
    claimId: "email:alice@example.com",
    kind: "email",
    method: "fixture",
    confirmedAt: 1_700_000_000,
    v: 1,
    ...overrides,
  };
}

describe("held confirm proofs", () => {
  it("rejects secrets, otp leftovers, and a users/…/claims/ path", () => {
    assert.equal(isHeldConfirmProof(proof()), true);
    assert.equal(isHeldConfirmProof({ ...proof(), code: "000000" }), false);
    assert.equal(isHeldConfirmProof({ ...proof(), otp: "000000" }), false);
    assert.equal(isHeldConfirmProof({ ...proof(), siwe: "sig" }), false);
    assert.equal(
      isHeldConfirmProof({
        ...proof(),
        claimId: "s3rch/users/0xalice/claims/email",
      }),
      false,
    );
    assert.equal(isHeldConfirmProof({ ...proof(), v: 2 }), false);
    assert.equal(
      isHeldConfirmProof({ ...proof(), kind: "email", claimId: "phone:+1" }),
      false,
    );
  });

  it("memory store keeps one proof per kind and never writes Gun", async () => {
    const store = createMemoryConfirmProofStore();
    await store.put(proof());
    await store.put(
      proof({
        kind: "kyc",
        claimId: "kyc:fixture:held",
        method: "fixture",
      }),
    );
    const rows = await store.list(ALICE.toLowerCase());
    assert.equal(rows.length, 2);
    assert.deepEqual(lookupsFromConfirmProofs(rows), {
      email: "alice@example.com",
      kyc: "fixture:held",
    });
    await assert.rejects(() =>
      store.put({ ...proof(), priv: "sea-priv" } as HeldConfirmProof),
    );
  });
});
