import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LOCAL_SESSION_SECRET } from "./config";
import {
  confirmClaimId,
  confirmFixtureEnabled,
  createHttpConfirmSender,
  hashConfirmBinding,
  notConfiguredSender,
  readConfirmChallenge,
  signConfirmChallenge,
  startHeldConfirm,
  verifyHeldConfirm,
  type ConfirmSender,
} from "./confirm";

const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const NOW = 1_700_000_000;

function recordingSender(
  result: Awaited<ReturnType<ConfirmSender["send"]>> = { sent: true },
): ConfirmSender & { sent: Array<{ kind: string; target: string; code: string }> } {
  const sent: Array<{ kind: string; target: string; code: string }> = [];
  return {
    sent,
    async send(input) {
      sent.push(input);
      return result;
    },
  };
}

describe("held confirm claim ids", () => {
  it("shapes email: and phone: without a users/…/claims/ path", () => {
    assert.equal(confirmClaimId("email", "Alice@Example.COM"), "email:alice@example.com");
    assert.equal(confirmClaimId("phone", "+1 (555) 123-4567"), "phone:+15551234567");
    assert.equal(confirmClaimId("email", "not-an-email"), null);
    assert.equal(confirmClaimId("phone", "555"), null);
    assert.equal(
      confirmClaimId("email", "alice@example.com")?.includes("/claims/"),
      false,
    );
  });
});

describe("confirmFixtureEnabled", () => {
  it("defaults on outside production; explicit flags win", () => {
    assert.equal(confirmFixtureEnabled({ NODE_ENV: "development" }), true);
    assert.equal(confirmFixtureEnabled({ NODE_ENV: "production" }), false);
    assert.equal(
      confirmFixtureEnabled({ NODE_ENV: "production", CONFIRM_FIXTURE: "1" }),
      true,
    );
    assert.equal(
      confirmFixtureEnabled({ NODE_ENV: "development", CONFIRM_FIXTURE: "0" }),
      false,
    );
  });
});

describe("startHeldConfirm / verifyHeldConfirm", () => {
  it("requires a SIWE session and does not invent a sender", async () => {
    const denied = await startHeldConfirm({
      sessionAddress: null,
      kind: "email",
      target: "alice@example.com",
      fixtureEnabled: true,
      sender: notConfiguredSender(),
    });
    assert.equal(denied.status, 401);

    const unset = await startHeldConfirm({
      sessionAddress: ALICE,
      kind: "email",
      target: "alice@example.com",
      fixtureEnabled: false,
      sender: notConfiguredSender(),
    });
    assert.deepEqual(unset, {
      status: 200,
      body: { status: "not_configured", error: "not configured" },
    });
  });

  it("fixture confirm stores a challenge and verifies the lab code", async () => {
    const now = Math.floor(Date.now() / 1000);
    const started = await startHeldConfirm({
      sessionAddress: ALICE.toLowerCase(),
      kind: "email",
      target: "Alice@Example.com",
      fixtureEnabled: true,
      sender: notConfiguredSender(),
      nowSeconds: now,
    });
    assert.equal(started.status, 200);
    assert.ok("challenge" in started && started.challenge);
    assert.equal(started.body.status, "fixture");
    if (!("claimId" in started.body)) throw new Error("expected claimId");
    assert.equal(started.body.claimId, "email:alice@example.com");

    const token = await signConfirmChallenge(started.challenge, LOCAL_SESSION_SECRET);
    const read = await readConfirmChallenge(token, LOCAL_SESSION_SECRET);
    assert.equal(read.address, ALICE);
    assert.equal(read.targetHash.includes("@"), false);

    const verified = await verifyHeldConfirm({
      sessionAddress: ALICE,
      kind: "email",
      target: "alice@example.com",
      code: "000000",
      challenge: started.challenge,
      nowSeconds: now + 10,
    });
    assert.deepEqual(verified, {
      status: 200,
      body: {
        kind: "email",
        claimId: "email:alice@example.com",
        method: "fixture",
      },
    });

    const other = await verifyHeldConfirm({
      sessionAddress: BOB,
      kind: "email",
      target: "alice@example.com",
      code: "000000",
      challenge: started.challenge,
      nowSeconds: now + 10,
    });
    assert.equal(other.status, 400);
  });

  it("env-gated sender issues a one-time otp and rejects a wrong code", async () => {
    const sender = recordingSender({ sent: true });
    const started = await startHeldConfirm({
      sessionAddress: ALICE,
      kind: "phone",
      target: "+15551234567",
      fixtureEnabled: false,
      sender,
      nowSeconds: NOW,
      randomCode: () => "654321",
    });
    assert.equal(started.status, 200);
    assert.ok("challenge" in started && started.challenge);
    assert.equal(started.body.status, "sent");
    assert.deepEqual(sender.sent, [
      { kind: "phone", target: "+15551234567", code: "654321" },
    ]);

    const miss = await verifyHeldConfirm({
      sessionAddress: ALICE,
      kind: "phone",
      target: "+15551234567",
      code: "000000",
      challenge: started.challenge,
      nowSeconds: NOW + 1,
    });
    assert.equal(miss.status, 400);

    const ok = await verifyHeldConfirm({
      sessionAddress: ALICE,
      kind: "phone",
      target: "+15551234567",
      code: "654321",
      challenge: started.challenge,
      nowSeconds: NOW + 1,
    });
    assert.deepEqual(ok, {
      status: 200,
      body: {
        kind: "phone",
        claimId: "phone:+15551234567",
        method: "otp",
      },
    });
  });

  it("http sender without a url is not configured", async () => {
    const sender = createHttpConfirmSender(null);
    const started = await startHeldConfirm({
      sessionAddress: ALICE,
      kind: "email",
      target: "alice@example.com",
      fixtureEnabled: false,
      sender,
    });
    assert.deepEqual(started.body, {
      status: "not_configured",
      error: "not configured",
    });
  });

  it("hashes bind address + kind + target and never embed the email", () => {
    const hash = hashConfirmBinding(ALICE, "email", "alice@example.com", "000000");
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(hash.includes("alice"), false);
    assert.equal(hash.includes("@"), false);
  });
});
