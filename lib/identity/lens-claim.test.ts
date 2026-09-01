import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  lensClaimLine,
  resolveLensHeldClaim,
  type LensAccount,
  type LensLookupClient,
} from "./lens-claim";

// Lens GraphQL 2026-09-01: 0xd8dA… still owns lens/vitalik at this account.
const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
// Anvil currently owns real Lens handles (nr0868889, …) — public-key collision,
// not a product example. Tests use it only as a mismatch / dummy owner.
const ANVIL = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ACCOUNT = "0xe4AaA97cdA406c6AF7C02a5260a8013910bd683C";

function mockLens(opts: {
  owned?: LensAccount[] | Error;
  forward?: LensAccount | null | Error;
}): LensLookupClient {
  return {
    async accountsOwnedBy() {
      if (opts.owned instanceof Error) throw opts.owned;
      return opts.owned ?? [];
    },
    async accountByAddress() {
      if (opts.forward instanceof Error) throw opts.forward;
      return opts.forward ?? null;
    },
  };
}

const vitalikOwned: LensAccount = {
  address: ACCOUNT,
  owner: VITALIK.toLowerCase(),
  handle: "vitalik",
};

describe("Lens held claim (owned reverse + owner forward)", () => {
  it("returns the handle when owned reverse and forward owner checksum-match", async () => {
    const claim = await resolveLensHeldClaim({
      address: VITALIK,
      client: mockLens({
        owned: [vitalikOwned],
        forward: { ...vitalikOwned, owner: VITALIK, handle: "vitalik" },
      }),
    });
    assert.deepEqual(claim, { name: "vitalik" });
    assert.equal(lensClaimLine(claim.name), "Lens claim: vitalik");
  });

  it("rejects reverse-only (forward missing) and does not display the unverified handle", async () => {
    const claim = await resolveLensHeldClaim({
      address: VITALIK,
      client: mockLens({ owned: [vitalikOwned], forward: null }),
    });
    assert.deepEqual(claim, { name: null });
    assert.equal(lensClaimLine(claim.name), null);
  });

  it("rejects a forward owner mismatch", async () => {
    const claim = await resolveLensHeldClaim({
      address: VITALIK,
      client: mockLens({
        owned: [vitalikOwned],
        forward: { address: ACCOUNT, owner: ANVIL, handle: "vitalik" },
      }),
    });
    assert.deepEqual(claim, { name: null });
  });

  it("ignores managed-shaped rows whose owner is not the session", async () => {
    const claim = await resolveLensHeldClaim({
      address: VITALIK,
      client: mockLens({
        owned: [{ address: ACCOUNT, owner: ANVIL, handle: "someone" }],
        forward: { address: ACCOUNT, owner: ANVIL, handle: "someone" },
      }),
    });
    assert.deepEqual(claim, { name: null });
  });

  it("treats reverse GraphQL failure as a quiet empty claim", async () => {
    const claim = await resolveLensHeldClaim({
      address: VITALIK,
      client: mockLens({
        owned: new Error("429 rate limited from api.lens.example"),
        forward: vitalikOwned,
      }),
    });
    assert.deepEqual(claim, { name: null });
  });

  it("treats forward GraphQL failure as a quiet empty claim", async () => {
    const claim = await resolveLensHeldClaim({
      address: VITALIK,
      client: mockLens({
        owned: [vitalikOwned],
        forward: new Error("timeout talking to api.lens.example"),
      }),
    });
    assert.deepEqual(claim, { name: null });
  });

  it("returns empty when the address owns no Lens account", async () => {
    const claim = await resolveLensHeldClaim({
      address: ANVIL,
      client: mockLens({ owned: [], forward: null }),
    });
    assert.deepEqual(claim, { name: null });
  });
});
