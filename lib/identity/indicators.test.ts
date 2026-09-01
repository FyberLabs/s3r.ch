import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  claimAddressForSession,
  emptyIndicators,
  lookupIndicatorsForSession,
  resolveSessionIndicators,
  type IndicatorClients,
} from "./indicators";
import type { FarcasterHubClient } from "./farcaster-claim";
import type { LensLookupClient } from "./lens-claim";
import type { Rss3GiClient } from "./rss3-claim";

// Same live addresses as ens/lens tests (re-checked 2026-09-01). Anvil is a
// mismatch dummy here — it currently owns Lens handles via key collision.
const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ANVIL = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ACCOUNT = "0xe4AaA97cdA406c6AF7C02a5260a8013910bd683C";
const FID = 3;

function clients(opts?: {
  farcasterCalls?: { reverse: number; forward: number };
  lensCalls?: { owned: number; forward: number };
  rss3Calls?: { overlay: number };
  farcaster?: "match" | "empty" | "error";
  lens?: "match" | "empty" | "error";
  rss3?: "match" | "empty" | "error";
}): IndicatorClients {
  const farcasterCalls = opts?.farcasterCalls ?? { reverse: 0, forward: 0 };
  const lensCalls = opts?.lensCalls ?? { owned: 0, forward: 0 };
  const rss3Calls = opts?.rss3Calls ?? { overlay: 0 };
  const farcasterMode = opts?.farcaster ?? "empty";
  const lensMode = opts?.lens ?? "empty";
  const rss3Mode = opts?.rss3 ?? "empty";

  const farcaster: FarcasterHubClient = {
    async idRegistryByAddress() {
      farcasterCalls.reverse += 1;
      if (farcasterMode === "error") throw new Error("hub down");
      if (farcasterMode !== "match") return null;
      return { fid: FID, to: VITALIK };
    },
    async idRegistryEventsByFid() {
      farcasterCalls.forward += 1;
      if (farcasterMode === "error") throw new Error("hub down");
      return [{ fid: FID, to: VITALIK }];
    },
    async userDataByFid() {
      return {
        messages: [
          { data: { userDataBody: { type: "USER_DATA_TYPE_USERNAME", value: "v" } } },
        ],
      };
    },
  };

  const lens: LensLookupClient = {
    async accountsOwnedBy() {
      lensCalls.owned += 1;
      if (lensMode === "error") throw new Error("lens down");
      if (lensMode !== "match") return [];
      return [{ address: ACCOUNT, owner: VITALIK, handle: "vitalik" }];
    },
    async accountByAddress() {
      lensCalls.forward += 1;
      if (lensMode === "error") throw new Error("lens down");
      return { address: ACCOUNT, owner: VITALIK, handle: "vitalik" };
    },
  };

  const rss3: Rss3GiClient = {
    async accountOverlay() {
      rss3Calls.overlay += 1;
      if (rss3Mode === "error") throw new Error("getaddrinfo ENOTFOUND gi.rss3.io");
      if (rss3Mode !== "match") return [];
      return [{ owner: VITALIK, platform: "Farcaster" }];
    },
  };

  return { farcaster, lens, rss3 };
}

describe("indicator session gate", () => {
  it("does not fetch when there is no session", async () => {
    let called = 0;
    const claim = await lookupIndicatorsForSession({
      session: null,
      lookup: async () => {
        called += 1;
        return {
          farcaster: { name: "v" },
          lens: { name: "vitalik" },
          rss3: { name: "footprint" },
        };
      },
    });
    assert.equal(called, 0);
    assert.deepEqual(claim, emptyIndicators());
    assert.equal(claimAddressForSession(null), null);
    assert.equal(claimAddressForSession({}), null);
  });

  it("checksums the session address before lookup", async () => {
    let seen: string | undefined;
    const claim = await lookupIndicatorsForSession({
      session: { address: VITALIK.toLowerCase() },
      lookup: async (address) => {
        seen = address;
        return {
          farcaster: { name: "v" },
          lens: { name: null },
          rss3: { name: null },
        };
      },
    });
    assert.equal(seen, getAddress(VITALIK));
    assert.equal(claim.farcaster.name, "v");
  });
});

describe("session-gated indicators HTTP helper", () => {
  it("does not call public clients without a session", async () => {
    const counts = {
      farcasterCalls: { reverse: 0, forward: 0 },
      lensCalls: { owned: 0, forward: 0 },
      rss3Calls: { overlay: 0 },
    };
    const result = await resolveSessionIndicators({
      sessionAddress: null,
      queryAddress: VITALIK,
      clients: clients({ ...counts, farcaster: "match", lens: "match", rss3: "match" }),
    });
    assert.equal(result.status, 401);
    assert.equal(counts.farcasterCalls.reverse, 0);
    assert.equal(counts.lensCalls.owned, 0);
    assert.equal(counts.rss3Calls.overlay, 0);
    if (result.status === 401) {
      assert.equal(result.body.error, "unauthorized");
      assert.equal("farcaster" in result.body, false);
    }
  });

  it("returns verified claims for the session address", async () => {
    const result = await resolveSessionIndicators({
      sessionAddress: VITALIK,
      queryAddress: VITALIK.toLowerCase(),
      clients: clients({ farcaster: "match", lens: "match", rss3: "match" }),
    });
    assert.deepEqual(result, {
      status: 200,
      body: {
        farcaster: { name: "v" },
        lens: { name: "vitalik" },
        rss3: { name: "Farcaster" },
      },
    });
  });

  it("refuses a query address that is not the session subject", async () => {
    const counts = {
      farcasterCalls: { reverse: 0, forward: 0 },
      lensCalls: { owned: 0, forward: 0 },
      rss3Calls: { overlay: 0 },
    };
    const result = await resolveSessionIndicators({
      sessionAddress: ANVIL,
      queryAddress: VITALIK,
      clients: clients({ ...counts, farcaster: "match" }),
    });
    assert.equal(result.status, 403);
    assert.equal(counts.farcasterCalls.reverse, 0);
    assert.equal(counts.lensCalls.owned, 0);
  });

  it("keeps Farcaster and Lens when RSS3 GI misses", async () => {
    const result = await resolveSessionIndicators({
      sessionAddress: VITALIK,
      clients: clients({ farcaster: "match", lens: "match", rss3: "error" }),
    });
    assert.deepEqual(result, {
      status: 200,
      body: {
        farcaster: { name: "v" },
        lens: { name: "vitalik" },
        rss3: { name: null },
      },
    });
  });

  it("swallows hub / GraphQL errors as quiet empty claims", async () => {
    const result = await resolveSessionIndicators({
      sessionAddress: VITALIK,
      clients: clients({ farcaster: "error", lens: "error", rss3: "error" }),
    });
    assert.deepEqual(result, { status: 200, body: emptyIndicators() });
  });
});
