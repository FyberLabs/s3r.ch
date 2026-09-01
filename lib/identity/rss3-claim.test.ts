import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveRss3HeldClaim,
  rss3ClaimLabel,
  rss3ClaimLine,
  type Rss3GiClient,
} from "./rss3-claim";

// GI is still DNS-dead (2026-09-01). These addresses are mock-only here.
const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ANVIL = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function mockGi(result: Rss3GiClient["accountOverlay"] | Error): Rss3GiClient {
  return {
    async accountOverlay(account) {
      if (result instanceof Error) throw result;
      return result(account);
    },
  };
}

describe("RSS3 held claim (GI overlay reverse + owner forward)", () => {
  it("returns a platform label when GI activities are owner-bound", async () => {
    const claim = await resolveRss3HeldClaim({
      address: VITALIK,
      client: mockGi(async () => [
        { owner: VITALIK.toLowerCase(), platform: "Farcaster" },
        { owner: VITALIK, platform: "Lens" },
      ]),
    });
    assert.deepEqual(claim, { name: "Farcaster, Lens" });
    assert.equal(rss3ClaimLine(claim.name), "RSS3 claim: Farcaster, Lens");
  });

  it("uses footprint when bound activities have no platform", async () => {
    const claim = await resolveRss3HeldClaim({
      address: VITALIK,
      client: mockGi(async () => [{ owner: VITALIK, platform: null }]),
    });
    assert.deepEqual(claim, { name: "footprint" });
    assert.equal(rss3ClaimLabel([{ owner: VITALIK }]), "footprint");
  });

  it("rejects owner-mismatch activities (one-way GI payload)", async () => {
    const claim = await resolveRss3HeldClaim({
      address: VITALIK,
      client: mockGi(async () => [{ owner: ANVIL, platform: "Farcaster" }]),
    });
    assert.deepEqual(claim, { name: null });
    assert.equal(rss3ClaimLine(claim.name), null);
  });

  it("treats a GI miss as a quiet empty claim", async () => {
    const claim = await resolveRss3HeldClaim({
      address: VITALIK,
      client: mockGi(new Error("getaddrinfo ENOTFOUND gi.rss3.io")),
    });
    assert.deepEqual(claim, { name: null });
  });

  it("returns empty when GI is up but the overlay has no activities", async () => {
    const claim = await resolveRss3HeldClaim({
      address: ANVIL,
      client: mockGi(async () => []),
    });
    assert.deepEqual(claim, { name: null });
  });
});
