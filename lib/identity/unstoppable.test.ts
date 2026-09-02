import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";
import {
  createFallbackUnstoppableClient,
  createUnstoppableLookupClient,
  unstoppableApiKey,
  unstoppableClaimAddressForSession,
  unstoppableClaimLine,
  lookupUnstoppableHeldClaimForSession,
  resolveSessionUnstoppableClaim,
  resolveUnstoppableHeldClaim,
  type UnstoppableLookupClient,
} from "./unstoppable";

// Clearly fake. Not a product example and not Anvil 0xf39F…
const DUMMY = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";
const OTHER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

function mockClient(opts: {
  reverse?: string | null | Error;
  forward?: Address | string | null | Error;
}): UnstoppableLookupClient {
  return {
    async reverseNameOf() {
      if (opts.reverse instanceof Error) throw opts.reverse;
      return opts.reverse ?? null;
    },
    async getEthAddress() {
      if (opts.forward instanceof Error) throw opts.forward;
      return (opts.forward ?? null) as Address | null;
    },
  };
}

describe("Unstoppable held claim (reverse + forward)", () => {
  it("returns the name when reverse and forward checksum-match the session address", async () => {
    const client = mockClient({
      reverse: "lab-fixture.crypto",
      forward: DUMMY.toLowerCase(),
    });
    const claim = await resolveUnstoppableHeldClaim({
      address: DUMMY,
      client,
    });
    assert.deepEqual(claim, { name: "lab-fixture.crypto" });
    assert.equal(
      unstoppableClaimLine(claim.name),
      "Unstoppable claim: lab-fixture.crypto",
    );
  });

  it("returns empty when there is no reverse record", async () => {
    const client = mockClient({ reverse: null, forward: DUMMY });
    const claim = await resolveUnstoppableHeldClaim({
      address: DUMMY,
      client,
    });
    assert.deepEqual(claim, { name: null });
    assert.equal(unstoppableClaimLine(claim.name), null);
  });

  it("rejects reverse-only (forward missing) and does not display the unverified name", async () => {
    const client = mockClient({
      reverse: "spoof.crypto",
      forward: null,
    });
    const claim = await resolveUnstoppableHeldClaim({
      address: DUMMY,
      client,
    });
    assert.deepEqual(claim, { name: null });
    assert.equal(unstoppableClaimLine(claim.name), null);
  });

  it("rejects a forward mismatch", async () => {
    const client = mockClient({
      reverse: "someone-else.x",
      forward: OTHER,
    });
    const claim = await resolveUnstoppableHeldClaim({
      address: DUMMY,
      client,
    });
    assert.deepEqual(claim, { name: null });
  });

  it("treats reverse RPC failure as a quiet empty claim", async () => {
    const client = mockClient({
      reverse: new Error("429 rate limited from public rpc.example"),
      forward: DUMMY,
    });
    const claim = await resolveUnstoppableHeldClaim({
      address: DUMMY,
      client,
    });
    assert.deepEqual(claim, { name: null });
  });

  it("treats forward RPC failure as a quiet empty claim", async () => {
    const client = mockClient({
      reverse: "lab-fixture.crypto",
      forward: new Error("timeout talking to rpc.example"),
    });
    const claim = await resolveUnstoppableHeldClaim({
      address: DUMMY,
      client,
    });
    assert.deepEqual(claim, { name: null });
  });
});

describe("Unstoppable claim session gate", () => {
  it("does not fetch when there is no session", async () => {
    let called = 0;
    const claim = await lookupUnstoppableHeldClaimForSession({
      session: null,
      lookup: async () => {
        called += 1;
        return { name: "lab-fixture.crypto" };
      },
    });
    assert.equal(called, 0);
    assert.deepEqual(claim, { name: null });
    assert.equal(unstoppableClaimAddressForSession(null), null);
    assert.equal(unstoppableClaimAddressForSession({}), null);
  });

  it("checksums the session address before lookup", async () => {
    let seen: string | undefined;
    const claim = await lookupUnstoppableHeldClaimForSession({
      session: { address: DUMMY.toLowerCase() },
      lookup: async (address) => {
        seen = address;
        return { name: "lab-fixture.crypto" };
      },
    });
    assert.equal(seen, getAddress(DUMMY));
    assert.deepEqual(claim, { name: "lab-fixture.crypto" });
  });
});

describe("session-gated Unstoppable HTTP helper", () => {
  it("does not call the public client without a session", async () => {
    let reverseCalls = 0;
    const client = mockClient({
      reverse: "lab-fixture.crypto",
      forward: DUMMY,
    });
    const wrapped: UnstoppableLookupClient = {
      async reverseNameOf(args) {
        reverseCalls += 1;
        return client.reverseNameOf(args);
      },
      getEthAddress: (args) => client.getEthAddress(args),
    };

    const result = await resolveSessionUnstoppableClaim({
      sessionAddress: null,
      queryAddress: DUMMY,
      client: wrapped,
    });
    assert.equal(result.status, 401);
    assert.equal(reverseCalls, 0);
    if (result.status === 401) {
      assert.equal(result.body.error, "unauthorized");
      assert.equal("name" in result.body, false);
    }
  });

  it("returns the verified name for the session address", async () => {
    const result = await resolveSessionUnstoppableClaim({
      sessionAddress: DUMMY,
      queryAddress: DUMMY.toLowerCase(),
      client: mockClient({
        reverse: "lab-fixture.nft",
        forward: DUMMY,
      }),
    });
    assert.deepEqual(result, {
      status: 200,
      body: { name: "lab-fixture.nft" },
    });
    assert.equal(
      unstoppableClaimLine(result.body.name),
      "Unstoppable claim: lab-fixture.nft",
    );
  });

  it("refuses a query address that is not the session subject", async () => {
    let called = 0;
    const client: UnstoppableLookupClient = {
      async reverseNameOf() {
        called += 1;
        return "lab-fixture.crypto";
      },
      async getEthAddress() {
        called += 1;
        return DUMMY as Address;
      },
    };
    const result = await resolveSessionUnstoppableClaim({
      sessionAddress: OTHER,
      queryAddress: DUMMY,
      client,
    });
    assert.equal(result.status, 403);
    assert.equal(called, 0);
  });
});

describe("Unstoppable Resolution fallback (optional key)", () => {
  it("treats an empty / unset key as no fallback (quiet empty on RPC miss)", async () => {
    assert.equal(unstoppableApiKey(""), null);
    assert.equal(unstoppableApiKey("   "), null);
    assert.equal(unstoppableApiKey(undefined), null);
    assert.equal(unstoppableApiKey("partner-key"), "partner-key");

    const client = createUnstoppableLookupClient({
      onChain: mockClient({
        reverse: new Error("polygon rpc timeout"),
        forward: DUMMY,
      }),
      apiKey: null,
    });
    const claim = await resolveUnstoppableHeldClaim({
      address: DUMMY,
      client,
    });
    assert.deepEqual(claim, { name: null });
  });

  it("falls back to Resolution only when on-chain throws and a key exists", async () => {
    let resolutionReverse = 0;
    const fallback: UnstoppableLookupClient = {
      async reverseNameOf() {
        resolutionReverse += 1;
        return "lab-fixture.wallet";
      },
      async getEthAddress() {
        return DUMMY as Address;
      },
    };
    const client = createFallbackUnstoppableClient({
      primary: mockClient({
        reverse: new Error("429 from polygon-rpc"),
        forward: new Error("429 from polygon-rpc"),
      }),
      fallback,
    });
    const claim = await resolveUnstoppableHeldClaim({
      address: DUMMY,
      client,
    });
    assert.equal(resolutionReverse, 1);
    assert.deepEqual(claim, { name: "lab-fixture.wallet" });
  });

  it("does not shop Resolution after a successful empty on-chain reverse", async () => {
    let resolutionReverse = 0;
    const client = createFallbackUnstoppableClient({
      primary: mockClient({ reverse: null, forward: DUMMY }),
      fallback: {
        async reverseNameOf() {
          resolutionReverse += 1;
          return "should-not-use.crypto";
        },
        async getEthAddress() {
          return DUMMY as Address;
        },
      },
    });
    const claim = await resolveUnstoppableHeldClaim({
      address: DUMMY,
      client,
    });
    assert.equal(resolutionReverse, 0);
    assert.deepEqual(claim, { name: null });
  });
});
