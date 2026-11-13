// Trusted HTTP/history/cryptographic contracts: run only in CI.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { p256 } from "@noble/curves/nist.js";
import { agentDelegationBytes, agentRevocationBytes, parseAgentDelegation, parsePrincipalId, signWithKeyring } from "sociacl-ids";
import { createAclDelegationSource, type DelegationTrust } from "./acl-delegation-source-server";
import { createIdentitySessions } from "./sea-session";
const f = JSON.parse(readFileSync(new URL("./vectors/acl-agent-owner.json", import.meta.url), "utf8"));
const config = { origin: "https://acl.example", tenant: "01234567-89ab-cdef-0123-456789abcdef", scope: "agents", apiKey: "private-test-key" };
const audience = "https://s3r.ch";
const principal = (value: string) => { const result = parsePrincipalId(value); assert.ok(result.ok); return result.value; };
function setup() {
  const key = new Uint8Array(32); key[31] = 1;
  const agentKey = new Uint8Array(32); agentKey[31] = 2;
  const point = p256.getPublicKey(agentKey, false);
  const agent = principal(Buffer.from(point.slice(1,33)).toString("base64url") + "." + Buffer.from(point.slice(33)).toString("base64url"));
  const owner = principal(f.genesis);
  const sign = (bytes: Uint8Array) => { const r = signWithKeyring(key, bytes, owner); assert.ok(r.ok); return r.value; };
  const unsigned = { v: 1 as const, principal: owner, agent, audience, scopes: ["forum:read"], nonce: "a".repeat(64), issuedAt: f.now, expiresAt: f.now+60 };
  const delegation = { ...unsigned, sig: sign(agentDelegationBytes(unsigned)) };
  const parsed = parseAgentDelegation(delegation); assert.ok(parsed.ok); const id = parsed.value.id;
  const cancel = { v: 1 as const, principal: owner, delegationId: id, issuedAt: f.now };
  const revocation = { ...cancel, sig: sign(agentRevocationBytes(cancel)) };
  const document = { fence: "a".repeat(64), snapshot: { audience, completeThrough: f.now,
    history: { completeThrough: f.now, links: [] as unknown[], accounts: [{ principal: owner, rotations: [] as unknown[], revocations: [] as unknown[], genesisEpubBindings: [f.binding] }] },
    rows: [{ kind: "delegation", record: delegation }] as { kind: string; record: unknown }[] } };
  let now = f.now, status = 200, calls = 0;
  const trust = { jwks: f.jwks, policy: f.policy, pinnedIss: new Set<string>(f.pinnedIss) } as DelegationTrust;
  const fetcher: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), "https://acl.example/api/v1/acl/sociacl/delegations/agents/snapshot");
    assert.equal(new Headers(options?.headers).get("X-Tenant-ID"), config.tenant);
    assert.equal(options?.redirect, "error");
    return Response.json(document, { status });
  };
  const source = createAclDelegationSource(config, audience, trust, fetcher, () => now);
  const sessions = createIdentitySessions({ origin: audience, secret: "x".repeat(32), consume: async () => true, clock: () => now, delegationSource: source });
  return { document, source, sessions, id, revocation, trust, calls: () => calls,
    offline: () => { status=503; }, advance: () => { now++; } };
}
test("authenticated owner snapshot supplies the existing agent issuer and retains cancellations", async () => {
  const h=setup();
  assert.ok(await h.source(h.id,f.now));
  assert.ok(await h.sessions.agentChallenge(h.id,["forum:read"]));
  h.document.snapshot.rows.push({kind:"revocation",record:h.revocation});
  assert.equal(await h.sessions.agentChallenge(h.id,["forum:read"]),null);
});
test("missing delegation is absence, missing owner history is unavailable", async () => {
  const h=setup();
  assert.equal(await h.source("bad",f.now),null); assert.equal(h.calls(),0);
  assert.equal(await h.source("b".repeat(64),f.now),null);
  h.document.snapshot.history.accounts=[];
  await assert.rejects(h.source(h.id,f.now));
});
test("wrong audience, stale source, duplicate accounts and untrusted binding deny", async () => {
  for (const mode of ["audience","stale","duplicate","binding","offline","clock"] as const) {
    const h=setup();
    if(mode==="audience") h.document.snapshot.audience="https://other.example";
    if(mode==="stale") h.document.snapshot.completeThrough--;
    if(mode==="duplicate") h.document.snapshot.history.accounts.push(h.document.snapshot.history.accounts[0]);
    if(mode==="binding") h.document.snapshot.history.accounts[0].genesisEpubBindings=[{...f.binding,keySig:"bad"}];
    if(mode==="offline") h.offline();
    if(mode==="clock") h.advance();
    await assert.rejects(h.source(h.id,f.now),mode);
  }
});
test("malformed or ambiguous delegation records never become verified absence", async () => {
  for (const mode of ["unknown","duplicate","malformed","bad-revoke","wrong-owner"] as const) {
    const h=setup();
    if(mode==="unknown") h.document.snapshot.rows.push({kind:"unknown",record:{}});
    if(mode==="duplicate") h.document.snapshot.rows.push(h.document.snapshot.rows[0]);
    if(mode==="malformed") h.document.snapshot.rows[0].record={};
    if(mode==="bad-revoke") h.document.snapshot.rows.push({kind:"revocation",record:{}});
    if(mode==="wrong-owner") h.document.snapshot.history.accounts[0].rotations=[{principal:"other",issuedAt:f.now}];
    await assert.rejects(h.source(h.id,f.now),mode);
  }
});
test("caller mutations cannot install new witness trust after construction", async () => {
  const h=setup();
  (h.trust.jwks.keys as unknown[]).splice(0);
  assert.ok(await h.sessions.agentChallenge(h.id,["forum:read"]));
});
