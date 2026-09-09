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

describe("oracles / payments env prep", () => {
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
  });

  it("documents fail-soft empty env and held hops", () => {
    const doc = prepDoc();
    assert.equal(doc.includes("fail-soft"), true);
    assert.equal(doc.includes("no hop"), true);
    assert.equal(doc.includes("/api/v1/oracles/v0/attest"), true);
    assert.equal(doc.includes("/api/v1/payments/v0/receipt"), true);
    assert.equal(doc.includes("Never `NEXT_PUBLIC_*`"), true);
    assert.equal(doc.includes("Do not invent a SociACL grant"), true);
  });

  it("does not ship a live oracles or payments hop", () => {
    assert.equal(existsSync(new URL("../app/api/oracles", import.meta.url)), false);
    assert.equal(existsSync(new URL("../app/api/payments", import.meta.url)), false);
    assert.equal(existsSync(new URL("./oracles-attest.ts", import.meta.url)), false);
    assert.equal(existsSync(new URL("./payments-access.ts", import.meta.url)), false);
  });
});
