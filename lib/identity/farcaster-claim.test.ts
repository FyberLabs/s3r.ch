import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  farcasterClaimLine,
  resolveFarcasterHeldClaim,
  type FarcasterHubClient,
  type FarcasterIdRegistryEvent,
} from "./farcaster-claim";

// Hubble 2026-09-01: 0xD702… is still fid 188133 custody (reverse + latest
// id-register `to`). USER_DATA is empty; "dwr-alt" below is a mock fname.
// Fid 3 (dwr) custody is 0x6b0bda3f2ffed5efc83fa8c024acff1dd45793f1, not this key.
const DWR_CUSTODY = "0xd7029bdea1c17493893aafe29aad69ef892b8ff2";
const ANVIL = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const FID = 188133;

function mockHub(opts: {
  reverse?: FarcasterIdRegistryEvent | null | Error;
  forward?: FarcasterIdRegistryEvent[] | Error;
  username?: string | null | Error;
}): FarcasterHubClient {
  return {
    async idRegistryByAddress() {
      if (opts.reverse instanceof Error) throw opts.reverse;
      return opts.reverse ?? null;
    },
    async idRegistryEventsByFid() {
      if (opts.forward instanceof Error) throw opts.forward;
      return opts.forward ?? [];
    },
    async userDataByFid() {
      if (opts.username instanceof Error) throw opts.username;
      if (!opts.username) return { messages: [] };
      return {
        messages: [
          {
            data: {
              userDataBody: { type: "USER_DATA_TYPE_USERNAME", value: opts.username },
            },
          },
        ],
      };
    },
  };
}

describe("Farcaster held claim (custody reverse + forward)", () => {
  it("returns the fname when reverse and forward checksum-match the session address", async () => {
    const event = { fid: FID, to: DWR_CUSTODY.toLowerCase() };
    const claim = await resolveFarcasterHeldClaim({
      address: DWR_CUSTODY,
      client: mockHub({ reverse: event, forward: [event], username: "dwr-alt" }),
    });
    assert.deepEqual(claim, { name: "dwr-alt" });
    assert.equal(farcasterClaimLine(claim.name), "Farcaster claim: dwr-alt");
  });

  it("falls back to fid:N when USER_DATA username is missing", async () => {
    const event = { fid: FID, to: DWR_CUSTODY };
    const claim = await resolveFarcasterHeldClaim({
      address: DWR_CUSTODY,
      client: mockHub({ reverse: event, forward: [event], username: null }),
    });
    assert.deepEqual(claim, { name: `fid:${FID}` });
    assert.equal(farcasterClaimLine(claim.name), `Farcaster claim: fid:${FID}`);
  });

  it("rejects reverse-only (forward missing) and does not display the unverified fname", async () => {
    const claim = await resolveFarcasterHeldClaim({
      address: DWR_CUSTODY,
      client: mockHub({
        reverse: { fid: FID, to: DWR_CUSTODY },
        forward: [],
        username: "spoof",
      }),
    });
    assert.deepEqual(claim, { name: null });
    assert.equal(farcasterClaimLine(claim.name), null);
  });

  it("rejects a forward custody mismatch", async () => {
    const claim = await resolveFarcasterHeldClaim({
      address: DWR_CUSTODY,
      client: mockHub({
        reverse: { fid: FID, to: DWR_CUSTODY },
        forward: [{ fid: FID, to: ANVIL }],
        username: "spoof",
      }),
    });
    assert.deepEqual(claim, { name: null });
  });

  it("rejects when reverse to does not checksum-match the session", async () => {
    const claim = await resolveFarcasterHeldClaim({
      address: DWR_CUSTODY,
      client: mockHub({
        reverse: { fid: FID, to: ANVIL },
        forward: [{ fid: FID, to: ANVIL }],
        username: "other",
      }),
    });
    assert.deepEqual(claim, { name: null });
  });

  it("treats reverse hub failure as a quiet empty claim", async () => {
    const claim = await resolveFarcasterHeldClaim({
      address: DWR_CUSTODY,
      client: mockHub({
        reverse: new Error("hub 429 rate limited from hub.example"),
        forward: [{ fid: FID, to: DWR_CUSTODY }],
        username: "dwr-alt",
      }),
    });
    assert.deepEqual(claim, { name: null });
  });

  it("treats forward hub failure as a quiet empty claim", async () => {
    const claim = await resolveFarcasterHeldClaim({
      address: DWR_CUSTODY,
      client: mockHub({
        reverse: { fid: FID, to: DWR_CUSTODY },
        forward: new Error("timeout talking to hub.example"),
        username: "dwr-alt",
      }),
    });
    assert.deepEqual(claim, { name: null });
  });

  it("returns empty when there is no custody record", async () => {
    const claim = await resolveFarcasterHeldClaim({
      address: ANVIL,
      client: mockHub({ reverse: null, forward: [], username: null }),
    });
    assert.deepEqual(claim, { name: null });
  });

  it("still shows fid:N when username lookup fails after a verified match", async () => {
    const event = { fid: FID, to: DWR_CUSTODY };
    const claim = await resolveFarcasterHeldClaim({
      address: DWR_CUSTODY,
      client: mockHub({
        reverse: event,
        forward: [event],
        username: new Error("userData timeout"),
      }),
    });
    assert.deepEqual(claim, { name: `fid:${FID}` });
  });
});
