import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { forumBotFixture } from "./forum-bot-test-fixture";
import vectors from "./identity/vectors/forum-authority.json";
import { createMemoryVisorCompanionSetStore } from "./visor-companion-set-store";
import {
  parseVisorCompanionResolveRequest,
  resolveVisorCompanionSquad,
  squadForumDestination,
  VISOR_COMPANION_AGENT_SCOPE,
} from "./visor-companion-squad";

const machineId = "11111111-1111-4111-8111-111111111111";
const setId = "22222222-2222-4222-8222-222222222222";
const gen = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function body(f: Awaited<ReturnType<typeof forumBotFixture>>, members: unknown[], generation = gen(1), evaluatedAt = f.now()) {
  return {
    version: 1,
    evaluatedAt,
    tenant: f.tenant,
    machineId,
    setId,
    setGeneration: generation,
    members,
  };
}

test("slice done check: Visor companion binding contract (#551)", async t => {
  const f = await forumBotFixture(t);
  const store = createMemoryVisorCompanionSetStore();
  const origin = "https://pilot.example.test";
  const snapshot = () => ({
    completeThrough: f.now(),
    rows: f.rows,
    history: { completeThrough: f.now(), links: [], accounts: [f.owner, f.a, f.b].map(pair => ({
      principal: pair.pub, rotations: [], revocations: [], genesisEpubBindings: [],
    })) },
  });
  const companion = randomUUID();
  const session = randomUUID();
  const generation = gen(1);
  const common = { squad: { forumId: f.forum, owner: f.owner.pub, label: "Pilot" }, origin, authority: { keys: [], pinnedIssuers: [], policy: vectors.context.policy },
    tenant: f.tenant, ownerPrincipal: f.owner.pub, store, clock: f.now, evaluatedAt: f.now(), snapshot: snapshot() };
  const first = await resolveVisorCompanionSquad({ ...common,
    request: parseVisorCompanionResolveRequest(body(f, [
      { role: "companion", principal: f.b.pub, companion, session, generation },
      { role: "external", principal: f.a.pub },
    ]))! });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.body.destination, squadForumDestination(origin));
  assert.deepEqual(first.body.roster.map(row => row.principal).sort(), [f.a.pub, f.b.pub].sort());
  const stale = await resolveVisorCompanionSquad({ ...common,
    request: parseVisorCompanionResolveRequest(body(f, [
      { role: "companion", principal: f.b.pub, companion, session, generation },
    ], gen(2)))! });
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.reason, "stale-generation");
  const removed = await resolveVisorCompanionSquad({ ...common,
    request: parseVisorCompanionResolveRequest(body(f, [{ role: "external", principal: f.a.pub }], gen(2)))! });
  assert.equal(removed.ok, true);
  if (!removed.ok) return;
  assert.deepEqual(removed.body.roster.map(row => row.principal), [f.a.pub]);
  const resurrected = await resolveVisorCompanionSquad({ ...common,
    request: parseVisorCompanionResolveRequest(body(f, [
      { role: "companion", principal: f.b.pub, companion, session, generation },
    ], gen(1)))! });
  assert.equal(resurrected.ok, false);
  if (!resurrected.ok) assert.equal(resurrected.reason, "stale-generation");
  const sameGenRevive = await resolveVisorCompanionSquad({ ...common,
    request: parseVisorCompanionResolveRequest(body(f, [
      { role: "companion", principal: f.b.pub, companion, session, generation },
      { role: "external", principal: f.a.pub },
    ], gen(2)))! });
  assert.equal(sameGenRevive.ok, false);
  if (!sameGenRevive.ok) assert.equal(sameGenRevive.reason, "stale-generation");
  const revoked = await resolveVisorCompanionSquad({ ...common, ownerPrincipal: f.b.pub, snapshot: snapshot(),
    request: parseVisorCompanionResolveRequest(body(f, [{ role: "external", principal: f.a.pub }], gen(3)))! });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.reason, "owner");
  const wrongTenant = await resolveVisorCompanionSquad({ ...common, tenant: randomUUID(),
    request: parseVisorCompanionResolveRequest(body(f, [{ role: "external", principal: f.a.pub }], gen(4)))! });
  assert.equal(wrongTenant.ok, false);
  assert.equal(wrongTenant.reason, "tenant");
  assert.equal(VISOR_COMPANION_AGENT_SCOPE, "squad:visor-companion:resolve");
  const skewed = await resolveVisorCompanionSquad({ ...common, evaluatedAt: f.now(),
    request: parseVisorCompanionResolveRequest(body(f, [{ role: "external", principal: f.a.pub }], gen(5), f.now() - 120))! });
  assert.equal(skewed.ok, false);
  if (!skewed.ok) assert.equal(skewed.reason, "scope-or-time");
});

test("parser rejects client roster forgery fields and tokenized destinations", () => {
  const helper = "axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY.T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
  assert.equal(parseVisorCompanionResolveRequest(null), null);
  assert.equal(parseVisorCompanionResolveRequest({ version: 1 }), null);
  assert.throws(() => squadForumDestination("http://insecure.example"));
  assert.equal(squadForumDestination("https://pilot.example.test"), "https://pilot.example.test/feed/squad/live");
  const tenant = randomUUID();
  const valid = parseVisorCompanionResolveRequest({
    version: 1, evaluatedAt: 1, tenant, machineId, setId, setGeneration: gen(1),
    members: [{ role: "external", principal: helper }],
  });
  assert.ok(valid);
  assert.equal(parseVisorCompanionResolveRequest({ ...valid, members: [{ role: "external", principal: "bad" }] }), null);
  assert.equal(parseVisorCompanionResolveRequest({
    version: 1, evaluatedAt: 1, tenant, machineId, setId, setGeneration: gen(1),
    members: [{ role: "companion", principal: helper, companion: randomUUID() }],
  }), null);
});