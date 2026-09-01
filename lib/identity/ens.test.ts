import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, type Address } from "viem";
import {
  ensClaimAddressForSession,
  ensClaimLine,
  lookupEnsHeldClaimForSession,
  resolveEnsHeldClaim,
  resolveSessionEnsClaim,
  type EnsLookupClient,
} from "./ens";

// Mainnet 2026-09-01: 0xd8dA… still reverse+forward vitalik.eth.
const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
// Well-known Anvil key. No ENS name. Do not treat as a product example.
const ANVIL = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function mockClient(opts: {
  reverse?: string | null | Error;
  forward?: Address | string | null | Error;
}): EnsLookupClient {
  return {
    async getEnsName() {
      if (opts.reverse instanceof Error) throw opts.reverse;
      return opts.reverse ?? null;
    },
    async getEnsAddress() {
      if (opts.forward instanceof Error) throw opts.forward;
      return (opts.forward ?? null) as Address | null;
    },
  };
}

describe("ENS held claim (reverse + forward)", () => {
  it("returns the name when reverse and forward checksum-match the session address", async () => {
    const client = mockClient({
      reverse: "vitalik.eth",
      forward: VITALIK.toLowerCase(),
    });
    const claim = await resolveEnsHeldClaim({ address: VITALIK, client });
    assert.deepEqual(claim, { name: "vitalik.eth" });
    assert.equal(ensClaimLine(claim.name), "ENS claim: vitalik.eth");
  });

  it("rejects reverse-only (forward missing) and does not display the unverified name", async () => {
    const client = mockClient({
      reverse: "spoof.eth",
      forward: null,
    });
    const claim = await resolveEnsHeldClaim({ address: VITALIK, client });
    assert.deepEqual(claim, { name: null });
    assert.equal(ensClaimLine(claim.name), null);
  });

  it("rejects a forward mismatch", async () => {
    const client = mockClient({
      reverse: "someone-else.eth",
      forward: ANVIL,
    });
    const claim = await resolveEnsHeldClaim({ address: VITALIK, client });
    assert.deepEqual(claim, { name: null });
  });

  it("treats reverse RPC failure as a quiet empty claim", async () => {
    const client = mockClient({
      reverse: new Error("429 rate limited from public rpc.example"),
      forward: VITALIK,
    });
    const claim = await resolveEnsHeldClaim({ address: VITALIK, client });
    assert.deepEqual(claim, { name: null });
  });

  it("treats forward RPC failure as a quiet empty claim", async () => {
    const client = mockClient({
      reverse: "vitalik.eth",
      forward: new Error("timeout talking to rpc.example"),
    });
    const claim = await resolveEnsHeldClaim({ address: VITALIK, client });
    assert.deepEqual(claim, { name: null });
  });

  it("returns empty when there is no reverse record", async () => {
    const client = mockClient({ reverse: null, forward: VITALIK });
    const claim = await resolveEnsHeldClaim({ address: ANVIL, client });
    assert.deepEqual(claim, { name: null });
  });
});

describe("ENS claim session gate", () => {
  it("does not fetch when there is no session", async () => {
    let called = 0;
    const claim = await lookupEnsHeldClaimForSession({
      session: null,
      lookup: async () => {
        called += 1;
        return { name: "vitalik.eth" };
      },
    });
    assert.equal(called, 0);
    assert.deepEqual(claim, { name: null });
    assert.equal(ensClaimAddressForSession(null), null);
    assert.equal(ensClaimAddressForSession({}), null);
  });

  it("checksums the session address before lookup", async () => {
    let seen: string | undefined;
    const claim = await lookupEnsHeldClaimForSession({
      session: { address: VITALIK.toLowerCase() },
      lookup: async (address) => {
        seen = address;
        return { name: "vitalik.eth" };
      },
    });
    assert.equal(seen, getAddress(VITALIK));
    assert.deepEqual(claim, { name: "vitalik.eth" });
  });
});

describe("session-gated ENS HTTP helper", () => {
  it("does not call the public client without a session", async () => {
    let reverseCalls = 0;
    const client = mockClient({
      reverse: "vitalik.eth",
      forward: VITALIK,
    });
    const wrapped: EnsLookupClient = {
      async getEnsName(args) {
        reverseCalls += 1;
        return client.getEnsName(args);
      },
      getEnsAddress: (args) => client.getEnsAddress(args),
    };

    const result = await resolveSessionEnsClaim({
      sessionAddress: null,
      queryAddress: VITALIK,
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
    const result = await resolveSessionEnsClaim({
      sessionAddress: VITALIK,
      queryAddress: VITALIK.toLowerCase(),
      client: mockClient({ reverse: "vitalik.eth", forward: VITALIK }),
    });
    assert.deepEqual(result, { status: 200, body: { name: "vitalik.eth" } });
  });

  it("refuses a query address that is not the session subject", async () => {
    let called = 0;
    const client: EnsLookupClient = {
      async getEnsName() {
        called += 1;
        return "vitalik.eth";
      },
      async getEnsAddress() {
        called += 1;
        return VITALIK as Address;
      },
    };
    const result = await resolveSessionEnsClaim({
      sessionAddress: ANVIL,
      queryAddress: VITALIK,
      client,
    });
    assert.equal(result.status, 403);
    assert.equal(called, 0);
  });
});
