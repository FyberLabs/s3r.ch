import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { p256 } from "@noble/curves/nist.js";
import { decodeJwt, SignJWT } from "jose";
import { agentDelegationBytes, agentRevocationBytes, parseAgentDelegation, parsePrincipalId, type ResolutionContext } from "sociacl-ids";
import { createIdentitySessions, type AgentDelegationSource } from "./sea-session";
import { signForumRecord } from "../forum-sign";
import type { SeaPair } from "./sea";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
const secret = "s".repeat(32), origin = "https://s3r.ch";
const sign = (bytes: Uint8Array, pair: SeaPair) => Buffer.from(p256.sign(bytes, Buffer.from(pair.priv, "base64url"), { prehash: true, format: "compact" })).toString("base64url");
function principal(key: string) { const r = parsePrincipalId(key); assert.ok(r.ok); return r.value; }
async function setup(lifetime = 600) {
  const owner = await sea.pair(), agent = await sea.pair(), stranger = await sea.pair();
  let now = 1700000000, complete = true, available = true, slow = false;
  const raw = { v: 1 as const, principal: principal(owner.pub), agent: principal(agent.pub), audience: origin,
    scopes: ["forum:read", "forum:write", "turn:allocate"], nonce: "a".repeat(64), issuedAt: now - 1, expiresAt: now + lifetime };
  const record = { ...raw, sig: sign(agentDelegationBytes(raw), owner) };
  const parsed = parseAgentDelegation(record); assert.ok(parsed.ok); const id = parsed.value.id;
  let revocations: unknown[] = [];
  const context: Omit<ResolutionContext, "now"> = { jwks: { keys: [] }, links: new Map(), revocations: [], pinnedIss: new Set(),
    policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, history: () => ({ ok: false, reason: "missing-history" }) };
  const source: AgentDelegationSource = async wanted => {
    if (!available || wanted !== id) return null;
    const at = now; if (slow) now++;
    return { completeThrough: complete ? at : at - 1, delegation: record, rotations: [], revocations, context };
  };
  const used = new Set<string>();
  const options = { origin, secret, clock: () => now, delegationSource: source,
    consume: async (value: string) => { if (used.has(value)) return false; used.add(value); return true; } };
  const sessions = createIdentitySessions(options);
  async function mint(scopes = ["forum:read"]) {
    const challenge = await sessions.agentChallenge(id, scopes); assert.ok(challenge);
    const proof = await signForumRecord(challenge, agent); assert.ok(proof);
    const token = await sessions.exchangeAgent(challenge, proof); assert.ok(token);
    return { challenge, proof, token };
  }
  return { owner, agent, stranger, record, id, options, sessions, mint, now: () => now,
    advance: (seconds: number) => { now += seconds; }, unavailable: () => { available = false; }, stale: () => { complete = false; }, slow: () => { slow = true; },
    revoke: (valid = true) => { const r = { v: 1 as const, principal: raw.principal, delegationId: id, issuedAt: now };
      revocations = [{ ...r, sig: sign(agentRevocationBytes(r), valid ? owner : stranger) }]; } };
}
test("agent proof exchanges only the signed narrowed scopes, distinct from browser identity", async () => {
  const h = await setup(), { token, challenge, proof } = await h.mint();
  const claims = decodeJwt(token);
  assert.equal(claims.sub, h.owner.pub); assert.equal(claims.agent, h.agent.pub);
  assert.deepEqual(claims.scopes, ["forum:read"]); assert.equal(claims.exp! - claims.iat!, 300);
  assert.deepEqual(await h.sessions.authenticateAgent(token, ["forum:read"]),
    { principal: h.owner.pub, agent: h.agent.pub, delegationId: h.id, scopes: ["forum:read"] });
  assert.equal(await h.sessions.authenticateAgent(token, ["forum:write"]), null);
  assert.equal(await h.sessions.authenticate(token), null);
  assert.equal(await h.sessions.exchange(challenge, proof), null);
  assert.equal(await h.sessions.authenticateAgent(challenge, ["forum:read"]), null);
  assert.equal(await h.sessions.exchangeAgent(challenge, proof), null);
  const browserChallenge = await h.sessions.challenge(h.agent.pub);
  assert.equal(await h.sessions.exchangeAgent(browserChallenge, (await signForumRecord(browserChallenge, h.agent))!), null);
});
test("owner signature is not agent possession; concurrent challenge reuse admits only one", async () => {
  const h = await setup(), challenge = await h.sessions.agentChallenge(h.id, ["forum:read"]); assert.ok(challenge);
  for (const pair of [h.owner, h.stranger]) assert.equal(await h.sessions.exchangeAgent(challenge, (await signForumRecord(challenge, pair))!), null);
  const proof = (await signForumRecord(challenge, h.agent))!;
  const results = await Promise.all([h.sessions.exchangeAgent(challenge, proof), h.sessions.exchangeAgent(challenge, proof)]);
  assert.equal(results.filter(Boolean).length, 1);
});
test("scope, audience, secret, delegation ID and expiry boundaries deny", async () => {
  const h = await setup(25), { token } = await h.mint();
  assert.equal(decodeJwt(token).exp, h.record.expiresAt);
  for (const scopes of [[], ["*"], ["forum"], ["admin"], ["forum:read", "forum:read"], ["turn:allocate", "forum:read"]]) {
    assert.equal(await h.sessions.agentChallenge(h.id, scopes), null);
    assert.equal(await h.sessions.authenticateAgent(token, scopes), null);
  }
  for (const changes of [{ origin: "https://other.example" }, { secret: "x".repeat(32) }, { delegationSource: undefined }]) {
    const other = createIdentitySessions({ ...h.options, ...changes });
    if (!("secret" in changes)) assert.equal(await other.agentChallenge(h.id, ["forum:read"]), null);
    assert.equal(await other.authenticateAgent(token, ["forum:read"]), null);
  }
  assert.equal(await h.sessions.agentChallenge("b".repeat(64), ["forum:read"]), null);
  h.advance(25); assert.equal(await h.sessions.authenticateAgent(token, ["forum:read"]), null);
  assert.equal(await h.sessions.agentChallenge(h.id, ["forum:read"]), null);
});
test("already issued tokens recheck signed revocations and complete current source on every use", async () => {
  for (const mode of ["revoke", "bad-revoke", "stale", "unavailable", "slow"] as const) {
    const h = await setup(), { token } = await h.mint();
    if (mode === "revoke" || mode === "bad-revoke") h.revoke(mode === "revoke"); else h[mode]();
    assert.equal(await h.sessions.authenticateAgent(token, ["forum:read"]), null, mode);
    assert.equal(await h.sessions.agentChallenge(h.id, ["forum:read"]), null, mode);
  }
});
test("revocation between challenge and exchange denies and unavailable replay storage never mints", async () => {
  const h = await setup(), challenge = await h.sessions.agentChallenge(h.id, ["forum:read"]); assert.ok(challenge);
  const proof = (await signForumRecord(challenge, h.agent))!;
  const unavailable = createIdentitySessions({ ...h.options, consume: async () => { throw Error("offline"); } });
  assert.equal(await unavailable.exchangeAgent(challenge, proof), null);
  h.revoke(); assert.equal(await h.sessions.exchangeAgent(challenge, proof), null);
});
test("even MAC-valid altered claims cannot exceed the current signed delegation", async () => {
  const h = await setup(), { token } = await h.mint();
  for (const change of [{ sub: h.stranger.pub }, { agent: h.owner.pub }, { scopes: ["admin"] },
    { delegationId: "b".repeat(64) }, { exp: h.now() + 301 }, { iat: h.now() + 1 }, { jti: "bad" }]) {
    const altered = await new SignJWT({ ...decodeJwt(token), ...change }).setProtectedHeader({ alg: "HS256", typ: "s3rch-agent-session-v1" }).sign(new TextEncoder().encode(secret));
    assert.equal(await h.sessions.authenticateAgent(altered, change.scopes ?? ["forum:read"]), null);
  }
});

test("expiry or revocation during atomic challenge consumption prevents issuance", async () => {
  for (const mode of ["expiry", "revocation"] as const) {
    const h = await setup(20), challenge = await h.sessions.agentChallenge(h.id, ["forum:read"]); assert.ok(challenge);
    const proof = (await signForumRecord(challenge, h.agent))!;
    const issuer = createIdentitySessions({ ...h.options, consume: async () => {
      if (mode === "expiry") h.advance(20); else h.revoke();
      return true;
    } });
    assert.equal(await issuer.exchangeAgent(challenge, proof), null, mode);
  }
});

test("agent challenge replay domains are isolated while resulting sessions remain compatible", async () => {
  const h = await setup(); let consumed = 0;
  const remote = createIdentitySessions({ ...h.options, challengeDomain: "a".repeat(64), consume: async () => { consumed++; return true; } });
  const challenge = await remote.agentChallenge(h.id, ["forum:read"]); assert.ok(challenge);
  const proof = (await signForumRecord(challenge, h.agent))!;
  assert.equal(await h.sessions.exchangeAgent(challenge, proof), null);
  const oldChallenge = await h.sessions.agentChallenge(h.id, ["forum:read"]); assert.ok(oldChallenge);
  assert.equal(await remote.exchangeAgent(oldChallenge, (await signForumRecord(oldChallenge, h.agent))!), null);
  assert.equal(consumed, 0);
  const token = await remote.exchangeAgent(challenge, proof); assert.ok(token);
  assert.ok(await h.sessions.authenticateAgent(token, ["forum:read"]));
});
