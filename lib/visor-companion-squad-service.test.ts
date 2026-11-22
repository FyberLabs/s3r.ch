import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { agentDelegationBytes, parseAgentDelegation, parsePrincipalId } from "sociacl-ids";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { createVisorCompanionSquadService } from "./visor-companion-squad-service";
import { createMemoryVisorCompanionSetStore } from "./visor-companion-set-store";
import { VISOR_COMPANION_AGENT_SCOPE } from "./visor-companion-squad";
import { createIdentitySessions } from "./identity/sea-session";
import { seaSessionCookieNames } from "./identity/sea-session-http";
import { signForumRecord } from "./forum-sign";
import vectors from "./identity/vectors/forum-authority.json";
import type { SeaPair } from "./identity/sea";

function delegationRecord(owner: SeaPair, agent: SeaPair, origin: string, now: number) {
  const sign = (bytes: Uint8Array, pair: SeaPair) => Buffer.from(p256.sign(bytes, Buffer.from(pair.priv, "base64url"), { prehash: true, format: "compact" })).toString("base64url");
  const principal = (key: string) => { const r = parsePrincipalId(key); assert.ok(r.ok); return r.value; };
  const raw = { v: 1 as const, principal: principal(owner.pub), agent: principal(agent.pub), audience: origin,
    scopes: ["forum:read", "squad:visor-companion:resolve"], nonce: "a".repeat(64), issuedAt: now - 1, expiresAt: now + 600 };
  return { ...raw, sig: sign(agentDelegationBytes(raw), owner) };
}

test("HTTP contract: agent and browser resolve current set without URL credentials", async t => {
  const f = await forumBotFixture(t);
  const origin = "https://pilot.example.test";
  const secret = "visor-companion-".repeat(8);
  const store = createMemoryVisorCompanionSetStore();
  const record = delegationRecord(f.owner, f.a, origin, f.now());
  const parsed = parseAgentDelegation(record);
  assert.ok(parsed.ok);
  const issuer = createIdentitySessions({ origin, secret, clock: f.now, consume: async () => true });
  const agentSessions = createIdentitySessions({ origin, secret, clock: f.now, consume: async () => true,
    delegationSource: async id => id === parsed.value.id ? {
      completeThrough: f.now(), delegation: record, rotations: [], revocations: [],
      context: { jwks: { keys: [] }, links: new Map(), revocations: [], pinnedIss: new Set(),
        policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, history: () => ({ ok: false, reason: "missing-history" }) },
    } : null });
  const challenge = await issuer.challenge(f.owner.pub);
  const proof = await signForumRecord(challenge, f.owner);
  assert.ok(proof);
  const cookie = await issuer.exchange(challenge, proof);
  assert.ok(cookie);
  let revokeOnAuthorityRead = false;
  let agentAuthorized = true;
  const service = createVisorCompanionSquadService({
    squad: { forumId: f.forum, owner: f.owner.pub, label: "Pilot" },
    origin, config: { keys: [], pinnedIssuers: [], policy: vectors.context.policy },
    tenant: f.tenant, store, clock: f.now,
    authenticate: async request => {
      const token = request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(seaSessionCookieNames()[0] + "="))?.split("=")[1];
      return token ? issuer.authenticate(token) : null;
    },
    authenticateAgent: async request => {
      const header = request.headers.get("authorization");
      if (!agentAuthorized || !header?.startsWith("Bearer ")) return null;
      return agentSessions.authenticateAgent(header.slice(7), [VISOR_COMPANION_AGENT_SCOPE]);
    },
    read: async at => {
      if (revokeOnAuthorityRead) agentAuthorized = false;
      return {
        completeThrough: at,
        rows: f.rows,
        history: { completeThrough: at, links: [], accounts: [f.owner, f.a, f.b].map(pair => ({
          principal: pair.pub, rotations: [], revocations: [], genesisEpubBindings: [],
        })) },
      };
    },
  });
  const machineId = randomUUID();
  const payload = {
    version: 1, evaluatedAt: f.now(), tenant: f.tenant, machineId,
    setId: randomUUID(), setGeneration: randomUUID(),
    members: [{ role: "external", principal: f.a.pub }],
  };
  const browser = await service(new Request(origin + "/api/squad/pilot/visor-companion", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", Cookie: `${seaSessionCookieNames()[0]}=${cookie}` },
    body: JSON.stringify(payload),
  }));
  assert.equal(browser.status, 200);
  const browserBody = await browser.json();
  assert.equal(browserBody.destination, `${origin}/feed/squad/live`);
  assert.ok(!browserBody.destination.includes("?"));
  const agentChallenge = await agentSessions.agentChallenge(parsed.value.id, [VISOR_COMPANION_AGENT_SCOPE]);
  assert.ok(agentChallenge);
  const agentProof = await signForumRecord(agentChallenge, f.a);
  assert.ok(agentProof);
  const token = await agentSessions.exchangeAgent(agentChallenge, agentProof);
  assert.ok(token);
  const currentPayload = { ...payload, setGeneration: randomUUID() };
  const native = await service(new Request(origin + "/api/squad/pilot/visor-companion", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(currentPayload),
  }));
  assert.equal(native.status, 200);
  const foreign = await service(new Request(origin + "/api/squad/pilot/visor-companion", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", Authorization: "Bearer forged",
      Cookie: `${seaSessionCookieNames()[0]}=${cookie}` },
    body: JSON.stringify(payload),
  }));
  assert.equal(foreign.status, 403);
  const nativeNoOrigin = await service(new Request(origin + "/api/squad/pilot/visor-companion", {
    method: "POST",
    headers: { Host: new URL(origin).host, "Content-Type": "application/json", Authorization: `Bearer ${token}`,
      "x-forwarded-proto": "https" },
    body: JSON.stringify(currentPayload),
  }));
  assert.equal(nativeNoOrigin.status, 200);
  const skewed = await service(new Request(origin + "/api/squad/pilot/visor-companion", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", Cookie: `${seaSessionCookieNames()[0]}=${cookie}` },
    body: JSON.stringify({ ...payload, evaluatedAt: f.now() - 120 }),
  }));
  assert.equal(skewed.status, 409);
  assert.deepEqual(await skewed.json(), { error: "scope-or-time" });
  revokeOnAuthorityRead = true;
  const unregisteredMachine = randomUUID();
  const denied = await service(new Request(origin + "/api/squad/pilot/visor-companion", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...payload, machineId: unregisteredMachine }),
  }));
  assert.equal(denied.status, 403);
  assert.equal((await store.read(f.tenant, f.owner.pub, unregisteredMachine)).snapshot, null);
});