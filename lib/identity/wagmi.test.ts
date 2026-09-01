import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { identityConnectors, walletConnectProjectId } from "./wagmi";

describe("walletConnectProjectId", () => {
  it("returns null when unset, empty, or whitespace", () => {
    assert.equal(walletConnectProjectId(undefined), null);
    assert.equal(walletConnectProjectId(""), null);
    assert.equal(walletConnectProjectId("   "), null);
  });

  it("returns the trimmed id when set", () => {
    assert.equal(walletConnectProjectId("abc123"), "abc123");
    assert.equal(walletConnectProjectId("  abc123  "), "abc123");
  });
});

describe("identityConnectors WalletConnect gate", () => {
  it("is injected-only when the project id is missing", () => {
    const connectors = identityConnectors(null);
    assert.equal(connectors.length, 1);
    assert.equal(connectorId(connectors[0]), "injected");
    assert.equal(
      connectors.some((connector) => connectorId(connector) === "walletConnect"),
      false,
    );
  });

  it("adds walletConnect when a project id is set (no live Reown project)", () => {
    const connectors = identityConnectors("unit-test-not-a-reown-project");
    const ids = connectors.map((connector) => connectorId(connector));
    assert.ok(ids.includes("injected"));
    assert.ok(ids.includes("walletConnect"));
  });
});

function connectorId(connector: unknown): string | undefined {
  if (typeof connector === "function") {
    const created = (
      connector as (config: {
        chains?: unknown;
        emitter?: { on(): void; off(): void; emit(): void };
      }) => { id?: string }
    )({
      chains: [],
      emitter: { on() {}, off() {}, emit() {} },
    });
    return created.id;
  }
  if (connector && typeof connector === "object" && "id" in connector) {
    return String((connector as { id: unknown }).id);
  }
  return undefined;
}
