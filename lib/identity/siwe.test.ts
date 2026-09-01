import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPublicClient,
  custom,
  getAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import {
  buildSiweMessage,
  canVerifySiweContractOnChain,
  defaultSiweVerifyClient,
  isAllowedSiweDomain,
  verifySiweLogin,
  type SiweSignatureVerifier,
} from "./siwe";

const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const SMART_ACCOUNT = getAddress("0xcccccccccccccccccccccccccccccccccccccccc");

/** viem's ERC-6492 deployless verifier returns a bool, not the 1271 magic. */
const ETH_CALL_TRUE =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex;
const ETH_CALL_FALSE =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

describe("SIWE domain allowlist", () => {
  it("allows s3r.ch and localhost with ports", () => {
    assert.equal(isAllowedSiweDomain("s3r.ch"), true);
    assert.equal(isAllowedSiweDomain("localhost:3000"), true);
    assert.equal(isAllowedSiweDomain("127.0.0.1:8080"), true);
  });

  it("rejects lookalikes", () => {
    assert.equal(isAllowedSiweDomain("s3r.ch.evil.com"), false);
    assert.equal(isAllowedSiweDomain("evil.com"), false);
    assert.equal(isAllowedSiweDomain("not-s3r.ch"), false);
  });
});

describe("SIWE parse/verify", () => {
  const nonce = "nOnce12345";
  const domain = "localhost:3000";

  async function signedFixture(
    overrides: {
      domain?: string;
      nonce?: string;
      expired?: boolean;
      chainId?: number;
      address?: string;
    } = {},
  ) {
    const account = privateKeyToAccount(ANVIL_KEY);
    const issuedAt = new Date("2026-09-01T17:00:00.000Z");
    const expirationTime = overrides.expired
      ? new Date("2026-09-01T16:00:00.000Z")
      : new Date("2026-09-01T17:10:00.000Z");
    const address = overrides.address ?? account.address;
    const message = buildSiweMessage({
      domain: overrides.domain ?? domain,
      address,
      uri: "http://localhost:3000",
      chainId: overrides.chainId ?? 1,
      nonce: overrides.nonce ?? nonce,
      issuedAt,
      expirationTime,
    });
    const signature = await account.signMessage({ message });
    return { message, signature, address };
  }

  it("verifies a fixture EOA signature", async () => {
    const { message, signature } = await signedFixture();
    assert.match(message, /Sign in to s3r\.ch/);
    assert.match(message, /localhost:3000 wants you to sign in with your Ethereum account/);

    const result = await verifySiweLogin({
      message,
      signature,
      expectedNonce: nonce,
      requestHost: domain,
      now: new Date("2026-09-01T17:01:00.000Z"),
    });
    assert.deepEqual(result, { ok: true, address: ANVIL_ADDRESS, chainId: 1 });
  });

  it("rejects a domain mismatch against the request host", async () => {
    const { message, signature } = await signedFixture();
    const result = await verifySiweLogin({
      message,
      signature,
      expectedNonce: nonce,
      requestHost: "s3r.ch",
      now: new Date("2026-09-01T17:01:00.000Z"),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /does not match this host/);
  });

  it("rejects a disallowed domain", async () => {
    const { message, signature } = await signedFixture({ domain: "evil.example" });
    const result = await verifySiweLogin({
      message,
      signature,
      expectedNonce: nonce,
      requestHost: "evil.example",
      now: new Date("2026-09-01T17:01:00.000Z"),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /not allowed/);
  });

  it("rejects a nonce mismatch", async () => {
    const { message, signature } = await signedFixture();
    const result = await verifySiweLogin({
      message,
      signature,
      expectedNonce: "otherNonce99",
      requestHost: domain,
      now: new Date("2026-09-01T17:01:00.000Z"),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /nonce/i);
  });

  it("rejects an expired message", async () => {
    const { message, signature } = await signedFixture({ expired: true });
    const result = await verifySiweLogin({
      message,
      signature,
      expectedNonce: nonce,
      requestHost: domain,
      now: new Date("2026-09-01T17:01:00.000Z"),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /expired/i);
  });

  it("rejects a bad signature", async () => {
    const { message } = await signedFixture();
    const result = await verifySiweLogin({
      message,
      signature: `0x${"ab".repeat(65)}`,
      expectedNonce: nonce,
      requestHost: domain,
      now: new Date("2026-09-01T17:01:00.000Z"),
      verifyClient: null,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /signature/i);
  });

  it("rejects an invalid SIWE address", async () => {
    const { message, signature } = await signedFixture();
    const broken = message.replace(ANVIL_ADDRESS, "0xnotanaddress");
    const result = await verifySiweLogin({
      message: broken,
      signature,
      expectedNonce: nonce,
      requestHost: domain,
      now: new Date("2026-09-01T17:01:00.000Z"),
    });
    assert.equal(result.ok, false);
  });

  it("verifies an Anvil/local EOA without a mainnet client", async () => {
    const { message, signature } = await signedFixture({ chainId: 31337 });
    let clientCalls = 0;
    const result = await verifySiweLogin({
      message,
      signature,
      expectedNonce: nonce,
      requestHost: domain,
      now: new Date("2026-09-01T17:01:00.000Z"),
      verifyClient: {
        async verifyMessage() {
          clientCalls += 1;
          throw new Error("Anvil EOA must not hit a contract client");
        },
      },
    });
    assert.deepEqual(result, {
      ok: true,
      address: ANVIL_ADDRESS,
      chainId: 31337,
    });
    assert.equal(clientCalls, 0);
    assert.equal(canVerifySiweContractOnChain(31337), false);
    assert.equal(canVerifySiweContractOnChain(1337), false);
    assert.equal(defaultSiweVerifyClient(31337), null);
    assert.equal(defaultSiweVerifyClient(1337), null);
  });
});

describe("SIWE ERC-1271 / EIP-6492 contract verify", () => {
  const nonce = "nOnce12345";
  const domain = "localhost:3000";
  const now = new Date("2026-09-01T17:01:00.000Z");

  async function contractSiwe(chainId = 1) {
    const account = privateKeyToAccount(ANVIL_KEY);
    const message = buildSiweMessage({
      domain,
      address: SMART_ACCOUNT,
      uri: "http://localhost:3000",
      chainId,
      nonce,
      issuedAt: new Date("2026-09-01T17:00:00.000Z"),
      expirationTime: new Date("2026-09-01T17:10:00.000Z"),
    });
    const signature = await account.signMessage({ message });
    return { message, signature };
  }

  function mockViemVerifyClient(opts: {
    ethCall?: Hex | Error;
  }): SiweSignatureVerifier {
    const client = createPublicClient({
      chain: mainnet,
      transport: custom({
        async request({ method }) {
          if (method === "eth_call") {
            if (opts.ethCall instanceof Error) throw opts.ethCall;
            return opts.ethCall ?? ETH_CALL_TRUE;
          }
          throw new Error(`unexpected rpc ${method}`);
        },
      }),
    });
    return {
      verifyMessage: (args) => client.verifyMessage(args),
    };
  }

  it("accepts ERC-1271 when the contract verifier returns success", async () => {
    const { message, signature } = await contractSiwe();
    const result = await verifySiweLogin({
      message,
      signature,
      expectedNonce: nonce,
      requestHost: domain,
      now,
      verifyClient: mockViemVerifyClient({ ethCall: ETH_CALL_TRUE }),
    });
    assert.deepEqual(result, {
      ok: true,
      address: SMART_ACCOUNT,
      chainId: 1,
    });
  });

  it("rejects ERC-1271 when the verifier returns a non-magic / false", async () => {
    const { message, signature } = await contractSiwe();
    const result = await verifySiweLogin({
      message,
      signature,
      expectedNonce: nonce,
      requestHost: domain,
      now,
      verifyClient: mockViemVerifyClient({ ethCall: ETH_CALL_FALSE }),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "SIWE signature is invalid.");
  });

  it("rejects ERC-1271 RPC errors as a quiet invalid signature", async () => {
    const { message, signature } = await contractSiwe();
    const result = await verifySiweLogin({
      message,
      signature,
      expectedNonce: nonce,
      requestHost: domain,
      now,
      verifyClient: {
        async verifyMessage() {
          throw new Error("429 rate limited from public rpc.example");
        },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "SIWE signature is invalid.");
      assert.equal(result.error.includes("429"), false);
      assert.equal(result.error.includes("rpc.example"), false);
    }
  });

  it("does not send an Anvil-chain contract verify to mainnet", async () => {
    const { message, signature } = await contractSiwe(31337);
    const result = await verifySiweLogin({
      message,
      signature,
      expectedNonce: nonce,
      requestHost: domain,
      now,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "SIWE signature is invalid.");

    const eoaOnly = await verifySiweLogin({
      message,
      signature,
      expectedNonce: nonce,
      requestHost: domain,
      now,
      verifyClient: null,
    });
    assert.equal(eoaOnly.ok, false);
    assert.equal(canVerifySiweContractOnChain(1), true);
    assert.equal(defaultSiweVerifyClient(31337), null);
  });
});
