// Trusted HTTP/history/cryptographic contracts: run only in CI.
import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentDelegation } from "sociacl-ids";
import { setup, f } from "./fixtures/agent-delegation";
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
    if(mode==="binding") h.document.snapshot.history.accounts[0].genesisEpubBindings=[{...h.document.snapshot.history.accounts[0].genesisEpubBindings[0],keySig:"bad"}];
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
test("caller mutations cannot install new witness trust after construction", async () => {
  const h=await setup();
  (h.trust.jwks.keys as unknown[]).splice(0);
  assert.ok(await h.sessions.agentChallenge(h.id,["forum:read"]));
});

test("returned contexts cannot mutate trust for later source reads", async () => {
  const h=await setup(), first=await h.source(h.id,f.now); assert.ok(first);
  (first.context.jwks.keys as unknown[]).splice(0);
  (first.context.pinnedIss as Set<string>).clear();
  assert.ok(await h.sessions.agentChallenge(h.id,["forum:read"]));
});

test("peer history resolves only enrolled owners within the complete time window", async () => {
  const h=await setup(); h.document.snapshot.history.links.push(h.oidc);
  const snapshot=await h.source(h.id,f.now); assert.ok(snapshot);
  const parsed=parseAgentDelegation(snapshot.delegation); assert.ok(parsed.ok);
  const owner=parsed.value.delegation.principal, agent=parsed.value.delegation.agent;
  for(let i=0;i<2;i++) {
    const resolved=snapshot.context.history(owner,f.now,f.now);
    assert.ok(resolved.ok); assert.equal(resolved.value.key,owner);
  }
  assert.equal(snapshot.context.history(agent,f.now,f.now).ok,false);
  assert.equal(snapshot.context.history(owner,f.now,f.now+1).ok,false);
  assert.equal(snapshot.context.history(owner,f.now-1,f.now-1).ok,false);
  h.document.snapshot.history.links.push(h.oidc);
  await assert.rejects(h.source(h.id,f.now));
});
test("malformed, foreign and future link indexes deny", async () => {
  for(const row of [null,{}, {kind:"wallet",principal:"bad",issuedAt:f.now}]) {
    const h=await setup(); h.document.snapshot.history.links.push(row);
    await assert.rejects(h.source(h.id,f.now));
  }
  const h=await setup(); h.document.snapshot.history.links.push({...h.oidc,issuedAt:f.now+1});
  await assert.rejects(h.source(h.id,f.now));
});
