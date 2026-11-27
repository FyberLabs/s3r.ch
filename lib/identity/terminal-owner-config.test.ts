// Pure configuration decoding; no signing, HTTP, persistence or browser work.
import test from "node:test";
import assert from "node:assert/strict";
import { PILOT_OWNER } from "./vectors/forum-squad-fixture";
import { parseTerminalScope } from "./terminal-run-client";
import { uniqueJson } from "./forum-witness-json";
import { parseTerminalOwnerConfig, terminalOwnerConfigName } from "./terminal-owner-config";
const scope = { suite: "flags-s3rch-browser", subject: "11111111-1111-1111-1111-111111111111", tenant: "22222222-2222-2222-2222-222222222222", organization: "", realm: "controlplane",
  issuer: "https://auth.test.hyperme.sh/realms/controlplane", clients: ["s3rch"], origins: ["https://test.s3r.ch"], identities: { sea: [] as string[] } };
const device = { ...scope, suite: "s3rch-device-transfer", identities: { sea: ["axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.sBy9HAHlgGVxGBS1g_Bh6dQxzKmUzqExNEm_l8hArgo"] } };
const config = { version: 1, owner: "s3rch", origin: "https://test.s3r.ch", authOrigin: "https://api.test.hyperme.sh",
  controllerKey: "c".repeat(64), ownerKey: "d".repeat(64), scopes: { "flags-s3rch-browser": scope, "s3rch-device-transfer": device } };
const parse = (value: unknown) => parseTerminalOwnerConfig(JSON.stringify(value));
test("prepared deployment JSON decodes into an immutable private owner configuration", () => {
  assert.equal(terminalOwnerConfigName, "S3RCH_NIGHTLY_RUN_CONFIG");
  assert.deepEqual(uniqueJson(JSON.stringify(config)), config);
  assert.deepEqual(parseTerminalScope(device), device);
  const result = parse(config); assert.deepEqual(result, config);
  for (const value of [result, result.scopes, result.scopes[scope.suite as "flags-s3rch-browser"], result.scopes["s3rch-device-transfer"].identities.sea]) assert.ok(Object.isFrozen(value));
  assert.notEqual(result.scopes["flags-s3rch-browser"], scope);
});
test("wrong owner, origins, key separation and unknown configuration fields refuse", () => {
  for (const change of [{ version: 2 }, { owner: "portal" }, { origin: "https://s3r.ch" }, { authOrigin: "https://auth.test.hyperme.sh" },
    { controllerKey: config.ownerKey }, { controllerKey: "short" }, { controllerKey: 1 }, { ownerKey: "D".repeat(64) }, { ownerKey: null }, { extra: true }])
    assert.throws(() => parse({ ...config, ...change }), { message: "Terminal owner configuration unavailable" });
  for (const value of [null, [], {}, "config"]) assert.throws(() => parse(value));
});
test("both exact suite bindings and the declared device SEA fixture are required", () => {
  for (const scopes of [{}, { "flags-s3rch-browser": scope }, { ...config.scopes, foreign: scope },
    { ...config.scopes, "flags-s3rch-browser": device },
    { ...config.scopes, "s3rch-device-transfer": { ...device, identities: { sea: [] } } },
    { ...config.scopes, "s3rch-device-transfer": { ...device, origins: ["https://portal.test.hyperme.sh", "https://test.s3r.ch"] } },
    { ...config.scopes, "s3rch-device-transfer": { ...device, identities: { sea: [PILOT_OWNER] } } },
    { ...config.scopes, "flags-s3rch-browser": { ...scope, subject: "undeclared" } }]) assert.throws(() => parse({ ...config, scopes }));
});
test("duplicate, malformed and oversized JSON never exposes input in errors", () => {
  for (const raw of ["{", " ".repeat(16385), JSON.stringify(config).replace('"version":1', '"version":1,"version":1'),
    JSON.stringify(config).replace('"sea":[]', '"sea":[],"sea":[]'), undefined as unknown as string])
    assert.throws(() => parseTerminalOwnerConfig(raw), { message: "Terminal owner configuration unavailable" });
});
