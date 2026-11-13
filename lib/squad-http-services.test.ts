import assert from "node:assert/strict";
import test from "node:test";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { createSquadHttpServices } from "./squad-http-services";
import { createIdentitySessions } from "./identity/sea-session";
import { seaSessionCookieNames } from "./identity/sea-session-http";
import { signForumRecord } from "./forum-sign";
import vectors from "./identity/vectors/forum-authority.json";
test("statement admission and authority reads share the injected primary history", async t => {
  const f = await forumBotFixture(t), origin = "https://forum.example.test", secret = "unit-secret-".repeat(8);
  const issuer = createIdentitySessions({ origin, secret, clock: f.now, consume: async () => true });
  const challenge = await issuer.challenge(f.b.pub), proof = await signForumRecord(challenge, f.b);
  assert.ok(proof); const token = await issuer.exchange(challenge, proof); assert.ok(token);
  const snapshot = () => ({ completeThrough: f.now(), rows: f.rows,
    history: { completeThrough: f.now(), links: [], accounts: [f.owner, f.a, f.b].map(pair =>
      ({ principal: pair.pub, rotations: [], revocations: [], genesisEpubBindings: [] })) } });
  let primaryReads = 0, legacyReads = 0;
  const options = { origin, secret, clock: f.now, consume: async () => true,
    squad: { owner: f.owner.pub, forumId: f.forum, label: "Unit thread" },
    config: { keys: [], pinnedIssuers: [], policy: vectors.context.policy },
    read: async () => { legacyReads++; throw Error("Legacy source must not be used"); } };
  assert.equal(createSquadHttpServices(options).statements, undefined);
  const services = createSquadHttpServices({ ...options, statements: {
    read: async () => { primaryReads++; return { snapshot: snapshot(), fence: "primary" }; },
    append: async () => { throw Error("Readiness must not write"); } } });
  const request = (rows?: unknown[]) => new Request(origin + "/api/squad/pilot/authority", { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", Cookie: seaSessionCookieNames()[0] + "=" + token },
    body: JSON.stringify({ version: 1, forumId: f.forum, owner: f.owner.pub, evaluatedAt: f.now(), ...(rows ? { rows } : {}) }) });
  assert.equal((await services.statements!(request([]))).status, 200);
  const signed = await f.signed(f.task());
  const response = await services.authority(request()); assert.equal(response.status, 200);
  const body = await response.json(); assert.ok(body.snapshot.rows.some((row: { kind: string; record: { object?: string } }) => row.kind === "object" && row.record.object === signed.id));
  assert.equal(primaryReads, 2); assert.equal(legacyReads, 0);
});

// Shared issuer / production reader contract: CI only.
test("production Squad verifies shared SEA sessions without exposing issuer actions", async t => {
  const { createSquadPilotServer } = await import("./squad-pilot-server");
  const f = await forumBotFixture(t), origin = "https://forum.example.test", secret = "shared-secret-".repeat(8);
  let at = f.now(), reads = 0;
  const issuer = createIdentitySessions({ origin, secret, clock:()=>at, consume:async()=>true });
  const challenge = await issuer.challenge(f.b.pub), proof = await signForumRecord(challenge,f.b);
  assert.ok(proof); const token = await issuer.exchange(challenge,proof); assert.ok(token);
  const runtime = createSquadPilotServer({version:1,origin,
    squad:{owner:f.owner.pub,forumId:f.forum,label:"Shared identity"},
    authority:{keys:[],pinnedIssuers:[],policy:vectors.context.policy}}, {
      read:async evaluatedAt=>{reads++;return {fence:"opaque",snapshot:{completeThrough:evaluatedAt,rows:f.rows,
        history:{completeThrough:evaluatedAt,links:[],accounts:[f.owner,f.a,f.b].map(pair=>
          ({principal:pair.pub,rotations:[],revocations:[],genesisEpubBindings:[]}))}}};},
      append:async()=>false,
    },{challengeDomain:"a".repeat(64),consume:async()=>{assert.fail("Squad must not issue or consume challenges");}},()=>at,secret);
  assert.deepEqual(Object.keys(runtime.services).sort(),["authenticate","authority","statements"]);
  const request=(value:string)=>new Request(origin+"/api/squad/pilot/authority",{method:"POST",
    headers:{Origin:origin,"Content-Type":"application/json",Cookie:seaSessionCookieNames()[0]+"="+value},
    body:JSON.stringify({version:1,forumId:f.forum,owner:f.owner.pub,evaluatedAt:at})});
  assert.deepEqual(await runtime.services.authenticate(request(token)),{key:f.b.pub});
  assert.equal((await runtime.services.authority(request(token))).status,200); assert.equal(reads,1);
  at+=300;
  assert.equal(await runtime.services.authenticate(request(token)),null);
  assert.equal((await runtime.services.authority(request(token))).status,403); assert.equal(reads,1);
});
