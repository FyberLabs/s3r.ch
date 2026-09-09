import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attestKycForSession,
  createFixtureKycIssuer,
  createNotConfiguredKycIssuer,
  FIXTURE_KYC_ISSUER,
  kycIssuers,
} from "./kyc";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("KYC attestation adapter", () => {
  it("fixture issuer holds kyc:<issuer>:<subject> without a claims path", async () => {
    const issuer = createFixtureKycIssuer();
    const held = await issuer.attest({ address: ALICE.toLowerCase() });
    assert.deepEqual(held, {
      ok: true,
      issuer: FIXTURE_KYC_ISSUER,
      subject: "held",
      claimId: "kyc:fixture:held",
    });
    assert.equal("claimId" in held && held.claimId.includes("/claims/"), false);

    const custom = await issuer.attest({ address: ALICE, subject: "lab-1" });
    assert.ok("ok" in custom && custom.ok);
    assert.equal(custom.claimId, "kyc:fixture:lab-1");
  });

  it("session-gates attest and fails closed for an unknown issuer", async () => {
    const issuers = {
      fixture: createFixtureKycIssuer(),
      env: createNotConfiguredKycIssuer("env"),
    };
    const denied = await attestKycForSession({
      sessionAddress: null,
      issuers,
    });
    assert.equal(denied.status, 401);

    const missing = await attestKycForSession({
      sessionAddress: ALICE,
      issuerId: "persona",
      issuers,
    });
    assert.deepEqual(missing, {
      status: 200,
      body: { status: "not_configured", error: "not configured" },
    });

    const unset = await attestKycForSession({
      sessionAddress: ALICE,
      issuerId: "env",
      issuers,
    });
    assert.deepEqual(unset, {
      status: 200,
      body: { status: "not_configured", error: "not configured" },
    });

    const ok = await attestKycForSession({
      sessionAddress: ALICE,
      issuers,
    });
    assert.deepEqual(ok, {
      status: 200,
      body: {
        claimId: "kyc:fixture:held",
        issuer: "fixture",
        subject: "held",
      },
    });
  });

  it("env map exposes fixture plus an honest not-configured env slot", () => {
    const issuers = kycIssuers({ NODE_ENV: "test" });
    assert.equal(issuers.fixture?.id, "fixture");
    assert.equal(issuers.env?.id, "env");
  });
});
