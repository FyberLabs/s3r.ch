import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { FORUM_AUTHORITY_CONFIG } from "./identity/forum-authority";
import { createRecordVisorCompanionSetStore, createSimulatedRecordStore } from "./visor-companion-set-store";
import {
  parseVisorCompanionResolveRequest,
  resolveVisorCompanionSquad,
  VISOR_COMPANION_EVALUATED_AT_SKEW_SECONDS,
  visorCompanionEvaluatedAtWithinSkew,
} from "./visor-companion-squad";
import vectors from "./identity/vectors/forum-authority.json";

const machineId = "11111111-1111-4111-8111-111111111111";
const setId = "22222222-2222-4222-8222-222222222222";
const gen = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

test("durable store keeps generation fencing across separate instances", async t => {
  const f = await forumBotFixture(t);
  const records = createSimulatedRecordStore();
  const forumId = f.forum;
  const storeA = createRecordVisorCompanionSetStore(records, forumId);
  const storeB = createRecordVisorCompanionSetStore(records, forumId);
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
  const origin = "https://pilot.example.test";
  const body = (setGeneration: string) => parseVisorCompanionResolveRequest({
    version: 1, evaluatedAt: f.now(), tenant: f.tenant, machineId, setId, setGeneration,
    members: [{ role: "companion", principal: f.b.pub, companion, session, generation }],
  })!;
  const common = {
    squad: { forumId, owner: f.owner.pub, label: "Pilot" }, origin,
    authority: FORUM_AUTHORITY_CONFIG,
    tenant: f.tenant, ownerPrincipal: f.owner.pub, clock: f.now, evaluatedAt: f.now(), snapshot: snapshot(),
    request: body(gen(1)),
  };
  const first = await resolveVisorCompanionSquad({ ...common, store: storeA });
  assert.equal(first.ok, true);
  const stale = await resolveVisorCompanionSquad({
    ...common, store: storeB, request: body(gen(2)),
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, "stale-generation");
  const replacement = { ...body(gen(2)), setId: randomUUID(), members: [] };
  const switched = await resolveVisorCompanionSquad({ ...common, store: storeB, request: replacement });
  assert.equal(switched.ok, true);
  const replayed = await resolveVisorCompanionSquad({ ...common, store: storeA, request: body(gen(1)) });
  assert.deepEqual(replayed, { ok: false, reason: "stale-generation" });
  const newer = await resolveVisorCompanionSquad({
    ...common, store: storeA, request: { ...replacement, setGeneration: gen(3) },
  });
  assert.equal(newer.ok, true);
  const emptyReplay = await resolveVisorCompanionSquad({ ...common, store: storeB, request: replacement });
  assert.deepEqual(emptyReplay, { ok: false, reason: "stale-generation" });
});

test("evaluation skew accepts in-window client timestamps and rejects outliers", () => {
  const serverAt = 1_000_000;
  assert.equal(VISOR_COMPANION_EVALUATED_AT_SKEW_SECONDS, 60);
  assert.equal(visorCompanionEvaluatedAtWithinSkew(serverAt, serverAt), true);
  assert.equal(visorCompanionEvaluatedAtWithinSkew(serverAt - 60, serverAt), true);
  assert.equal(visorCompanionEvaluatedAtWithinSkew(serverAt + 60, serverAt), true);
  assert.equal(visorCompanionEvaluatedAtWithinSkew(serverAt - 61, serverAt), false);
  assert.equal(visorCompanionEvaluatedAtWithinSkew(serverAt + 61, serverAt), false);
});

test("resolve returns server evaluatedAt while honoring in-window client skew", async t => {
  const f = await forumBotFixture(t);
  const records = createSimulatedRecordStore();
  const store = createRecordVisorCompanionSetStore(records, f.forum);
  const serverAt = f.now() + 5;
  const clientAt = serverAt - 30;
  const result = await resolveVisorCompanionSquad({
    squad: { forumId: f.forum, owner: f.owner.pub, label: "Pilot" },
    origin: "https://pilot.example.test",
    authority: FORUM_AUTHORITY_CONFIG,
    tenant: f.tenant, ownerPrincipal: f.owner.pub, store, clock: () => serverAt, evaluatedAt: serverAt,
    snapshot: { completeThrough: serverAt, rows: f.rows,
      history: { completeThrough: serverAt, links: [], accounts: [f.owner, f.a, f.b].map(pair => ({
        principal: pair.pub, rotations: [], revocations: [], genesisEpubBindings: [],
      })) } },
    request: parseVisorCompanionResolveRequest({
      version: 1, evaluatedAt: clientAt, tenant: f.tenant, machineId, setId, setGeneration: gen(1),
      members: [{ role: "external", principal: f.a.pub }],
    })!,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.body.evaluatedAt, serverAt);
    assert.notEqual(result.body.evaluatedAt, clientAt);
  }
});