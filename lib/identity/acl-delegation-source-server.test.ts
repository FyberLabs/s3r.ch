// Trusted HTTP/history/cryptographic contracts: run only in CI.
import test from "node:test";
import assert from "node:assert/strict";
import { importJWK, SignJWT } from "jose";
import { parseAgentDelegation, parsePrincipalId, signingBytes, signWithKeyring } from "sociacl-ids";
import { authenticatedHistoryContexts, type DelegationTrust } from "./acl-delegation-source-server";
import { setup, f } from "./fixtures/agent-delegation";

const emptyTrust = (): DelegationTrust => structuredClone({ jwks: { keys: [] }, policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIss: new Set<string>() });

async function ownerGenesisBinding(principal: string): Promise<{ binding: Record<string, unknown>; jwk: Record<string, unknown> }> {
  const key = new Uint8Array(32); key[31] = 103;
  const parsed = parsePrincipalId(principal); assert.ok(parsed.ok);
  const witness = new Uint8Array(32); witness[31] = 101;
  const epubKey = new Uint8Array(32); epubKey[31] = 107;
  const { p256 } = await import("@noble/curves/nist.js");
  const witnessPoint = p256.getPublicKey(witness, false), epubPoint = p256.getPublicKey(epubKey, false);
  const jwk = { kty: "EC" as const, crv: "P-256" as const, kid: "ci-genesis", x: Buffer.from(witnessPoint.slice(1, 33)).toString("base64url"),
    y: Buffer.from(witnessPoint.slice(33)).toString("base64url"), notBefore: f.now - 1000, notAfter: f.now + 1000 };
  const epub = parsePrincipalId(Buffer.from(epubPoint.slice(1, 33)).toString("base64url") + "." + Buffer.from(epubPoint.slice(33)).toString("base64url"));
  assert.ok(epub.ok);
  const genesis = { v: 1 as const, kind: "genesis-epub" as const, principal: parsed.value, epub: epub.value, issuedAt: f.now };
  const bytes = signingBytes(genesis); assert.ok(bytes.ok);
  const sign = (value: Uint8Array) => { const r = signWithKeyring(key, value, parsed.value); assert.ok(r.ok); return r.value; };
  const attest = await new SignJWT({ typ: "sociacl-genesis-epub-attest-v1", principal: parsed.value, epub: epub.value })
    .setProtectedHeader({ alg: "ES256", kid: jwk.kid }).setIssuedAt(f.now).setExpirationTime(f.now + 60)
    .sign(await importJWK({ ...jwk, d: Buffer.from(witness).toString("base64url") }, "ES256"));
  return { binding: { ...genesis, keySig: sign(bytes.value), attest }, jwk };
}
test("authenticated owner snapshot supplies the existing agent issuer and retains cancellations", async () => {
  const h=await setup();
  assert.ok(await h.source(h.id,f.now));
  assert.ok(await h.sessions.agentChallenge(h.id,["forum:read"]));
  h.document.snapshot.rows.push({kind:"revocation",record:h.revocation});
  assert.equal(await h.sessions.agentChallenge(h.id,["forum:read"]),null);
});
test("missing delegation is absence, missing owner history is unavailable", async () => {
  const h=await setup();
  assert.equal(await h.source("bad",f.now),null); assert.equal(h.calls(),0);
  assert.equal(await h.source("b".repeat(64),f.now),null);
  h.document.snapshot.history.accounts=[];
  await assert.rejects(h.source(h.id,f.now));
});
test("wrong audience, stale source, duplicate accounts and untrusted binding deny", async () => {
  for (const mode of ["audience","stale","duplicate","binding","offline","clock"] as const) {
    const h=await setup();
    if(mode==="audience") h.document.snapshot.audience="https://other.example";
    if(mode==="stale") h.document.snapshot.completeThrough--;
    if(mode==="duplicate") h.document.snapshot.history.accounts.push(h.document.snapshot.history.accounts[0]);
    if (mode === "binding") (h.document.snapshot.history.accounts[0] as { genesisEpubBindings: unknown[] }).genesisEpubBindings =
      [{ v: 1, kind: "genesis-epub", principal: "bad", epub: "bad", issuedAt: 0, keySig: "bad", attest: "bad" }];
    if(mode==="offline") h.offline();
    if(mode==="clock") h.advance();
    await assert.rejects(h.source(h.id,f.now),mode);
  }
});
test("malformed or ambiguous delegation records never become verified absence", async () => {
  for (const mode of ["unknown","duplicate","malformed","bad-revoke","wrong-owner"] as const) {
    const h=await setup();
    if(mode==="unknown") h.document.snapshot.rows.push({kind:"unknown",record:{}});
    if(mode==="duplicate") h.document.snapshot.rows.push(h.document.snapshot.rows[0]);
    if(mode==="malformed") h.document.snapshot.rows[0].record={};
    if(mode==="bad-revoke") h.document.snapshot.rows.push({kind:"revocation",record:{}});
    if(mode==="wrong-owner") h.document.snapshot.history.accounts[0].rotations=[{principal:"other",issuedAt:f.now}];
    await assert.rejects(h.source(h.id,f.now),mode);
  }
});
test("peer history resolves only enrolled owners within the complete time window", async () => {
  const h = await setup();
  const snapshot = await h.source(h.id, f.now); assert.ok(snapshot);
  const parsed = parseAgentDelegation(snapshot.delegation); assert.ok(parsed.ok);
  const owner = parsed.value.delegation.principal, agent = parsed.value.delegation.agent;
  for (let i = 0; i < 2; i++) {
    const resolved = snapshot.context.history(owner, f.now, f.now);
    assert.ok(resolved.ok); assert.equal(resolved.value.key, owner);
  }
  assert.equal(snapshot.context.history(agent, f.now, f.now).ok, false);
  assert.equal(snapshot.context.history(owner, f.now, f.now + 1).ok, false);
});
test("malformed, foreign and future link indexes deny", async () => {
  for (const row of [null, {}, { kind: "wallet", principal: "bad", issuedAt: f.now }]) {
    const h = await setup(); h.document.snapshot.history.links.push(row);
    await assert.rejects(h.source(h.id, f.now));
  }
});

test("duplicate authenticated links deny", async () => {
  const h = await setup();
  const row = parseAgentDelegation(h.document.snapshot.rows[0].record); assert.ok(row.ok);
  const owner = row.value.delegation.principal;
  const link = { v: 1, kind: "wallet", principal: owner, address: "0x2222222222222222222222222222222222222222",
    nonce: "d".repeat(16), issuedAt: f.now - 60, keySig: "k", attest: "a" };
  h.document.snapshot.history.links = [link, structuredClone(link)];
  await assert.rejects(h.source(h.id, f.now), /Duplicate link/);
});

test("genesis-bound owners require resolved epub in peer history", async () => {
  const h = await setup();
  const row = parseAgentDelegation(h.document.snapshot.rows[0].record); assert.ok(row.ok);
  const owner = row.value.delegation.principal;
  const { binding, jwk } = await ownerGenesisBinding(owner);
  const history = structuredClone(h.document.snapshot.history) as { completeThrough: number; links: unknown[]; accounts: { principal: string; rotations: unknown[]; revocations: unknown[]; genesisEpubBindings: unknown[] }[] };
  history.accounts[0].genesisEpubBindings = [binding];
  const trust: DelegationTrust = { jwks: { keys: [jwk as DelegationTrust["jwks"]["keys"][number]] }, policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIss: new Set() };
  const { contextFor } = authenticatedHistoryContexts(history, trust, f.now);
  const resolved = contextFor(owner, f.now).history!(owner, f.now, f.now);
  assert.ok(resolved.ok);
  assert.throws(() => authenticatedHistoryContexts({
    ...history,
    accounts: [{ ...history.accounts[0], genesisEpubBindings: [{ ...binding, attest: "broken" }] }],
  }, trust, f.now), /Invalid owner history/);
});
