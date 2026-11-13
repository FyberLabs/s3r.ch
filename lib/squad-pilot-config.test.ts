import test from "node:test";
import assert from "node:assert/strict";
import { p256 } from "@noble/curves/nist.js";
import { parseSquadPilotConfig, publicSquadPilotConfig } from "./squad-pilot-config";
import { seaToPrincipalKey } from "./identity/forum-check";
const secret = Buffer.alloc(32, 53), pub = p256.getPublicKey(secret, false), x = Buffer.from(pub.slice(1, 33)).toString("base64url"), y = Buffer.from(pub.slice(33)).toString("base64url"), owner = x + "." + y;
const witness = p256.getPublicKey(Buffer.alloc(32, 56), false), wx = Buffer.from(witness.slice(1, 33)).toString("base64url"), wy = Buffer.from(witness.slice(33)).toString("base64url");
const config = () => ({ version: 1, origin: "https://s3r.ch", squad: { forumId: `forum_${seaToPrincipalKey(owner)}_${"a".repeat(32)}`, owner, label: "Pilot" },
  authority: { keys: [{ kid: "witness", kty: "EC", crv: "P-256", x: wx, y: wy, notBefore: 100, notAfter: 200 }],
    policy: { allowedDomains: ["s3r.ch"], allowedUris: ["https://s3r.ch"], allowedChainIds: ["84532"] }, pinnedIssuers: [] } });
test("pilot is explicitly disabled or requires complete secret-backed scope and witness policy", () => {
  assert.equal(parseSquadPilotConfig(undefined), null); assert.equal(parseSquadPilotConfig(""), null);
  for (const changes of [{ origin: "http://s3r.ch" }, { ownerSigningKey: "invalid" }, { sessionSecret: "short" }, { unexpected: true },
    { authority: { ...config().authority, keys: [] } }, { authority: { ...config().authority, keys: [config().authority.keys[0], config().authority.keys[0]] } }]) {
    assert.throws(() => parseSquadPilotConfig(JSON.stringify({ ...config(), ...changes })));
  }
  const c = parseSquadPilotConfig(JSON.stringify(config())); assert.ok(c);
  const browser = publicSquadPilotConfig(c), serialized = JSON.stringify(browser);
  assert.ok(!serialized.includes(secret.toString("hex")));
  const retired = parseSquadPilotConfig(JSON.stringify({ ...config(), ownerSigningKey: secret.toString("hex") }));
  assert.equal("ownerSigningKey" in retired!, false);
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

test("ledger-only operator access needs no identity secret while the HTTP server does", async () => {
  const { createSquadPilotSource, createSquadPilotFixture } = await import("../scripts/squad-pilot-fixture");
  const { BlobServiceClient } = await import("@azure/storage-blob");
  const container = new BlobServiceClient("https://fixture.blob.core.windows.net").getContainerClient("fixture");
  const client = container.getBlockBlobClient("unused");
  client.download = async () => { throw Object.assign(Error("missing"), { statusCode: 404, code: "BlobNotFound" }); };
  const fake = { getBlockBlobClient: () => client };
  const saved = process.env.IDENTITY_SESSION_SECRET;
  try {
    delete process.env.IDENTITY_SESSION_SECRET;
    const c = parseSquadPilotConfig(JSON.stringify(config()))!;
    const source = createSquadPilotSource(c, fake);
    await assert.rejects(source.load(), /missing/);
    assert.throws(() => createSquadPilotFixture(c, fake), /IDENTITY_SESSION_SECRET is required/);
  } finally {
    if (saved === undefined) delete process.env.IDENTITY_SESSION_SECRET; else process.env.IDENTITY_SESSION_SECRET = saved;
  }
});

test("configured remote replay is passed into the existing issuer without constructing a Blob replay slot", async () => {
  const { createSquadPilotFixture } = await import("../scripts/squad-pilot-fixture");
  const { createRequire } = await import("node:module");
  const { signForumRecord } = await import("./forum-sign");
  const { decodeProtectedHeader } = await import("jose");
  const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<import("./identity/sea").SeaPair> };
  const pair = await sea.pair(), paths: string[] = [];
  const { BlobServiceClient } = await import("@azure/storage-blob");
  const container = new BlobServiceClient("https://fixture.blob.core.windows.net").getContainerClient("fixture");
  const fake = { getBlockBlobClient(path: string) { paths.push(path); return container.getBlockBlobClient(path); } };
  let consumed = 0;
  const replay = { challengeDomain: "a".repeat(64), consume: async () => { consumed++; return true; } };
  const c = parseSquadPilotConfig(JSON.stringify(config()))!;
  const server = createSquadPilotFixture(c, fake, () => 100, "s".repeat(32), replay);
  assert.ok(paths.length); assert.ok(paths.every(path => !path.includes("session-replay")));
  const request = (body: unknown, cookie = "") => new Request("https://s3r.ch/api/squad/session", {
    method: "POST", headers: { origin: "https://s3r.ch", "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  const challenged = await server.services.challenge(request({ key: pair.pub }));
  assert.equal(challenged.status, 200);
  const { challenge } = await challenged.json() as { challenge: string };
  assert.equal(decodeProtectedHeader(challenge).typ, "s3rch-identity-challenge-v1:" + replay.challengeDomain);
  const signature = await signForumRecord(challenge, pair); assert.ok(signature);
  const exchanged = await server.services.exchange(request({ challenge, signature }, "__Host-s3rch-squad-challenge=" + challenge));
  assert.equal(exchanged.status, 200); assert.equal(consumed, 1);
});
