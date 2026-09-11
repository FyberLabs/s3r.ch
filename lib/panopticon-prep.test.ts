import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

function envExample(): string {
  return readFileSync(new URL("../.env.example", import.meta.url), "utf8");
}

function prepDoc(): string {
  return readFileSync(
    new URL("../docs/oracles-and-payments-prep.md", import.meta.url),
    "utf8",
  );
}

const LAB_ORIGIN = "https://api.test.hyperme.sh";

/** True when text names the lab origin host — not a substring-in-any-URL check. */
function mentionsLabOrigin(text: string): boolean {
  const expected = new URL(LAB_ORIGIN);
  const found = text.match(/https?:\/\/[^\s`'"]+/g) ?? [];
  return found.some((raw) => {
    try {
      const url = new URL(raw.replace(/[.,;:)]+$/, ""));
      return url.protocol === expected.protocol && url.hostname === expected.hostname;
    } catch {
      return false;
    }
  });
}

describe("oracles consume / payments consume", () => {
  it("names server-only bases and reuses TURN tenant/key", () => {
    const env = envExample();
    assert.equal(env.includes("PANOPTICON_ORACLES_BASE="), true);
    assert.equal(env.includes("PANOPTICON_PAYMENTS_BASE="), true);
    assert.equal(env.includes("PANOPTICON_TENANT_ID="), true);
    assert.equal(env.includes("PANOPTICON_API_KEY="), true);
    assert.equal(env.includes("NEXT_PUBLIC_PANOPTICON"), false);
    assert.equal(env.includes("Never NEXT_PUBLIC_*"), true);
    assert.equal(env.includes("oracles-attest-v0.md"), true);
    assert.equal(env.includes("payments-access-v0.md"), true);
    assert.equal(env.includes("/api/v1/oracles/v0/attest"), true);
    assert.equal(mentionsLabOrigin(env), true);
    assert.equal(env.includes("/api/payments/receipt"), true);
  });

  it("documents fail-soft empty env and both consume smokes", () => {
    const doc = prepDoc();
    assert.equal(doc.includes("fail-soft"), true);
    assert.equal(doc.includes("no hop"), true);
    assert.equal(doc.includes("/api/oracles/attest"), true);
    assert.equal(doc.includes("/api/v1/oracles/v0/attest"), true);
    assert.equal(doc.includes("/api/v1/payments/v0/receipt"), true);
    assert.equal(doc.includes("/api/payments/receipt"), true);
    assert.equal(doc.includes("payments-unconfigured"), true);
    assert.equal(doc.includes("oracles-unconfigured"), true);
    assert.equal(doc.includes("unauthorized"), true);
    assert.equal(doc.includes("Never `NEXT_PUBLIC_*`"), true);
    assert.equal(doc.includes("Do not invent a SociACL grant"), true);
    assert.equal(doc.includes("Not Stripe"), true);
  });

  it("ships oracles attest and payments receipt/intent hops", () => {
    assert.equal(existsSync(new URL("./oracles-attest.ts", import.meta.url)), true);
    assert.equal(
      existsSync(new URL("../app/api/oracles/attest/route.ts", import.meta.url)),
      true,
    );
    assert.equal(existsSync(new URL("./payments-access.ts", import.meta.url)), true);
    assert.equal(
      existsSync(new URL("../app/api/payments/receipt/route.ts", import.meta.url)),
      true,
    );
    assert.equal(
      existsSync(new URL("../app/api/payments/intent/route.ts", import.meta.url)),
      true,
    );
  });
});
