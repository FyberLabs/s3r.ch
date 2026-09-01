import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { buildSiweMessage, isAllowedSiweDomain, verifySiweLogin } from "./siwe";

const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

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

  async function signedFixture(overrides: { domain?: string; nonce?: string; expired?: boolean } = {}) {
    const account = privateKeyToAccount(ANVIL_KEY);
    const issuedAt = new Date("2026-09-01T17:00:00.000Z");
    const expirationTime = overrides.expired
      ? new Date("2026-09-01T16:00:00.000Z")
      : new Date("2026-09-01T17:10:00.000Z");
    const message = buildSiweMessage({
      domain: overrides.domain ?? domain,
      address: account.address,
      uri: "http://localhost:3000",
      chainId: 1,
      nonce: overrides.nonce ?? nonce,
      issuedAt,
      expirationTime,
    });
    const signature = await account.signMessage({ message });
    return { message, signature, address: account.address };
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
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /signature/i);
  });
});
