import test from "node:test";
import assert from "node:assert/strict";
import { p256 } from "@noble/curves/nist.js";
import { parseSquadPilotConfig, publicSquadPilotConfig } from "./squad-pilot-config";
import { seaToPrincipalKey } from "./identity/forum-check";
const secret = Buffer.alloc(32, 53), pub = p256.getPublicKey(secret, false), x = Buffer.from(pub.slice(1, 33)).toString("base64url"), y = Buffer.from(pub.slice(33)).toString("base64url"), owner = x + "." + y;
const witness = p256.getPublicKey(Buffer.alloc(32, 56), false), wx = Buffer.from(witness.slice(1, 33)).toString("base64url"), wy = Buffer.from(witness.slice(33)).toString("base64url");
const config = () => ({ version: 1, origin: "https://s3r.ch", squad: { forumId: `forum_${seaToPrincipalKey(owner)}_${"a".repeat(32)}`, owner, label: "Pilot" },
  authority: { keys: [{ kid: "witness", kty: "EC", crv: "P-256", x: wx, y: wy, notBefore: 100, notAfter: 200 }],
    policy: { allowedDomains: ["s3r.ch"], allowedUris: ["https://s3r.ch"], allowedChainIds: ["84532"] }, pinnedIssuers: [] },
  ownerSigningKey: secret.toString("hex") });
test("pilot is explicitly disabled or requires complete secret-backed scope and witness policy", () => {
  assert.equal(parseSquadPilotConfig(undefined), null); assert.equal(parseSquadPilotConfig(""), null);
  for (const changes of [{ origin: "http://s3r.ch" }, { ownerSigningKey: "0".repeat(64) }, { sessionSecret: "short" }, { unexpected: true },
    { authority: { ...config().authority, keys: [] } }, { authority: { ...config().authority, keys: [config().authority.keys[0], config().authority.keys[0]] } }]) {
    assert.throws(() => parseSquadPilotConfig(JSON.stringify({ ...config(), ...changes })));
  }
  const c = parseSquadPilotConfig(JSON.stringify(config())); assert.ok(c);
  const browser = publicSquadPilotConfig(c), serialized = JSON.stringify(browser);
  assert.ok(!serialized.includes(c.ownerSigningKey));
  assert.deepEqual(Object.keys(browser).sort(), ["assignmentBase", "authorityEndpoint", "config", "origin", "sessionBase", "squad"]);
  Object.assign(browser.config.keys[0], { kid: "changed" });
  assert.equal(c.authority.keys[0].kid, "witness");
});

test("report destinations must be explicit distinct live forums", () => {
  const c = config();
  const fleet = { ...c.squad, forumId: c.squad.forumId.slice(0, -32) + "b".repeat(32), label: "Fleet" };
  const command = { ...fleet, forumId: fleet.forumId.slice(0, -32) + "c".repeat(32), label: "Command" };
  const parse = (reportParents: unknown) => parseSquadPilotConfig(JSON.stringify({ ...c, reportParents }))!;
  assert.deepEqual(publicSquadPilotConfig(parse({ fleet, command })).reportParents, { fleet, command });
  for (const invalid of [null, { fleet }, { fleet, command: fleet }, { fleet: c.squad, command }, { fleet, command: {} }])
    assert.throws(() => parse(invalid));
});

test("old deployment documents cannot select a Squad signing secret", () => {
  const current = parseSquadPilotConfig(JSON.stringify(config()));
  const old = parseSquadPilotConfig(JSON.stringify({ ...config(), sessionSecret: "f".repeat(64) }));
  assert.deepEqual(old, current);
  assert.ok(old && !("sessionSecret" in old));
});
