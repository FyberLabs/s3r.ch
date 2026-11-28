// Isolated configuration units; no HTTP, storage or signature operations.
import test from "node:test";
import assert from "node:assert/strict";
import { agentSessionConfig } from "./agent-session-config";
const origin = "https://s3r.ch";
const config = () => ({ origin, source: { origin: "https://acl.example", tenant: "tenant", scope: "agents" } });
const env = (value: unknown) => ({ S3RCH_AGENT_SESSION_CONFIG: JSON.stringify(value), S3RCH_SERVICE_CREDENTIAL: "private-key" });

test("agent session configuration is absent by default and explicit when supplied", () => {
  assert.equal(agentSessionConfig(origin, {}), undefined);
  const result = agentSessionConfig(origin, env(config()));
  assert.ok(result);
  assert.equal(result.source.apiKey, "private-key");
  assert.deepEqual(result.trust.jwks.keys, []);
});

test("partial, oversized, duplicate and wrong-origin configurations deny", () => {
  for (const value of [{ S3RCH_SERVICE_CREDENTIAL: "private-key" }, { S3RCH_AGENT_SESSION_CONFIG: "{}" },
    { ...env(config()), S3RCH_AGENT_SESSION_CONFIG: " ".repeat(65537) },
    { ...env(config()), S3RCH_AGENT_SESSION_CONFIG: '{"origin":"a","origin":"b"}' },
    env({ ...config(), origin: "https://foreign.example" }), env({})]) {
    assert.throws(() => agentSessionConfig(origin, value));
  }
});

test("deployment witness configuration is not accepted", () => {
  assert.throws(() => agentSessionConfig(origin, env({
    ...config(),
    authority: { jwks: { keys: [{ kty: "EC", crv: "P-256", kid: "witness", x: "x".repeat(43), y: "y".repeat(43), notBefore: 0, notAfter: 1 }] },
      policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [], clockSkewSeconds: 0 }, pinnedIss: [] },
  })));
});

test("invalid source fields deny", () => {
  const value = config();
  value.source.scope = "";
  assert.throws(() => agentSessionConfig(origin, env(value)));
});