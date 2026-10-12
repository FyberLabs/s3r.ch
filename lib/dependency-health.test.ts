import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { panopticonHealth, recordIntegrationHop, resetIntegrationHopsForTests } from "./dependency-health";
import { ATTEST_SUBJECT } from "./oracles-attest.fixtures";
import { sessionGatedAttest } from "./oracles-attest";
import { sessionGatedIntent } from "./payments-access";

const FULL_ENV = {
  PANOPTICON_TENANT_ID: "00000000-0000-4000-8000-000000000001",
  PANOPTICON_API_KEY: "key",
  PANOPTICON_PAYMENTS_BASE: "https://plane.example.org",
  PANOPTICON_ORACLES_BASE: "https://plane.example.org",
  PANOPTICON_TURN_BASE: "https://plane.example.org",
};
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

afterEach(() => resetIntegrationHopsForTests());

describe("integration health", () => {
  it("reports not-configured with no settings at all", () => {
    const health = panopticonHealth({});
    assert.equal(health.status, "not-configured");
    assert.equal(health.services.payments.status, "not-configured");
    assert.equal(health.staticTurn, "not-configured");
  });

  it("needs the tenant and key, not only a base URL", () => {
    assert.equal(panopticonHealth({ PANOPTICON_PAYMENTS_BASE: "https://plane.example.org" }).status, "not-configured");
  });

  it("reports an unreachable service after a failed hop and recovers after a good one", () => {
    recordIntegrationHop("payments", false);
    assert.equal(panopticonHealth(FULL_ENV).status, "degraded");
    assert.equal(panopticonHealth(FULL_ENV).services.payments.status, "unreachable");
    recordIntegrationHop("payments", true);
    assert.equal(panopticonHealth(FULL_ENV).services.payments.status, "ok");
    assert.equal(panopticonHealth(FULL_ENV).status, "configured");
  });

  it("payments and attestations answer 503 when unset and when unreachable", async () => {
    const offline = async (): Promise<Response> => {
      throw new Error("offline");
    };
    const intent = { resource: "post-123", asset: "USDC" };
    const attest = { kind: "public_attestation", subject: ATTEST_SUBJECT };
    assert.deepEqual(await sessionGatedIntent({ sessionAddress: ADDRESS, body: intent, env: {} }), {
      status: 503,
      body: { error: "payments-unconfigured" },
    });
    assert.deepEqual(await sessionGatedAttest({ sessionAddress: ADDRESS, body: attest, env: {} }), {
      status: 503,
      body: { error: "oracles-unconfigured" },
    });
    assert.deepEqual(
      await sessionGatedIntent({ sessionAddress: ADDRESS, body: intent, env: FULL_ENV, fetchImpl: offline }),
      { status: 503, body: { error: "payments-unavailable" } },
    );
    assert.deepEqual(
      await sessionGatedAttest({ sessionAddress: ADDRESS, body: attest, env: FULL_ENV, fetchImpl: offline }),
      { status: 503, body: { error: "oracles-unavailable" } },
    );
    const health = panopticonHealth(FULL_ENV);
    assert.equal(health.services.payments.status, "unreachable");
    assert.equal(health.services.oracles.status, "unreachable");
    assert.equal(health.services.turn.status, "configured");
  });
});
