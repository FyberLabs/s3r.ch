import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { signForumRecord } from "./forum-sign";
import { createIdentitySessions } from "./identity/sea-session";
import { readSeaSessionCookie, seaSessionCookieNames } from "./identity/sea-session-http";
import vectors from "./identity/vectors/forum-authority.json";
import { createSquadPlaneForum, squadPlaneTaskId } from "./squad-plane-forum";
import { createSquadProjectService } from "./squad-project-service";
import { squadProjectDelegationRequest } from "./squad-project-client";
import { createSquadProjectStore } from "./squad-project";
import { createSimulatedRecordStore } from "./visor-companion-set-store";

async function fixture(t: test.TestContext) {
  const f = await forumBotFixture(t);
  const origin = "https://forum.example.test";
  const plane = { origin: "https://plane.example.test", tenant: f.tenant, roster: {
    [f.botA]: f.a.pub, [f.botB]: f.b.pub,
  } };
  const squad = { forumId: f.forum, owner: f.owner.pub, label: "Partner pilot" };
  const config = { keys: [], pinnedIssuers: [], policy: vectors.context.policy };
  const consumed = new Set<string>();
  const sessions = createIdentitySessions({ origin, secret: "squad-project-fixture-key".repeat(2), clock: f.now,
    consume: async id => {
      if (consumed.has(id)) return false;
      consumed.add(id);
      return true;
    } });
  const challenge = await sessions.challenge(f.owner.pub);
  const signature = await signForumRecord(challenge, f.owner);
  assert.ok(signature);
  const browserSession = await sessions.exchange(challenge, signature);
  assert.ok(browserSession);
  const authenticate = (request: Request) => sessions.authenticate(readSeaSessionCookie(request) ?? "");
  let revoked = false, agentRevoked = false, fail = 0, loseResponse = false, active = true;
  let deliveries = 0;
  const submitted = new Set<string>();
  const authority = {
    squad, config, plane, authenticate, clock: f.now,
    read: async (at: number) => ({ completeThrough: at, rows: revoked ? f.rows.slice(0, 1) : f.rows,
      history: { completeThrough: at, links: [], accounts: [f.owner, f.a, f.b].map(pair =>
        ({ principal: pair.pub, rotations: [], revocations: [], genesisEpubBindings: [] })) } }),
  };
  const dispatch = createSquadPlaneForum({ ...authority, siteOrigin: origin, fetch: async (url, init) => {
    const endpoint = new URL(String(url));
    assert.equal(endpoint.origin, plane.origin);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer plane-owner-fixture");
    assert.equal(new Headers(init?.headers).has("Cookie"), false);
    const bot = endpoint.pathname.split("/").at(-3)!;
    const row = JSON.parse(String(init?.body));
    assert.equal(row.forum_id, f.forum);
    const isControl = endpoint.pathname.endsWith("/control");
    if (!isControl) {
      deliveries++;
      if (fail) return Response.json({}, { status: fail });
      assert.equal(row.principal, plane.roster[bot]);
      submitted.add(row.source_task_id);
      if (loseResponse) throw Error("simulated upstream disconnect");
    }
    return Response.json({ version: 1, tenant_id: f.tenant, bot_id: bot, assignment_id: row.assignment_id,
      session_id: row.session_id, task_id: squadPlaneTaskId(f.tenant, f.forum, row.source_task_id),
      forum: { id: f.forum, principal: plane.roster[bot], source_task_id: row.source_task_id, kind: "remote-agent" },
      desired: "running", status: isControl && !active ? "completed" : "queued" });
  } });
  const store = createSquadProjectStore(createSimulatedRecordStore(), f.tenant, f.forum);
  const service = createSquadProjectService({ ...authority, origin, store, dispatch, authenticateAgent: async request => {
    const token = request.headers.get("authorization");
    const agent = token === "Bearer fixture-agent-a" ? f.a.pub : token === "Bearer fixture-agent-b" ? f.b.pub : null;
    return agent && !agentRevoked ? { principal: f.owner.pub, agent, delegationId: "fixture-grant" } : null;
  } });
  const call = (body: object, credential = "plane-owner-fixture", browser = true) => service(new Request(origin + "/api/squad/pilot/project", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + credential,
      ...(browser ? { Origin: origin, Cookie: seaSessionCookieNames()[0] + "=" + browserSession } : {}) },
    body: JSON.stringify({ forum: f.forum, ...body }),
  }));
  const ok = async (body: object) => {
    const response = await call(body);
    assert.equal(response.status, 200);
    return response.json();
  };
  const intent = (bot: string) => ({ version: 1, bot_id: bot, source_task_id: randomUUID(), assignment_id: randomUUID(),
    session_id: randomUUID(), kind: "remote-agent", request_sha256: "1".repeat(64) });
  async function project() {
    const root = randomUUID(), child = randomUUID(), taskId = randomUUID();
    await ok({ action: "node", id: root, title: "Partner", parentId: null, cursor: 0 });
    await ok({ action: "node", id: child, title: "Requirements", parentId: root, cursor: 1 });
    const add = { action: "create-task", id: taskId, nodeId: child, outcome: "Confirm 10 pilot seats", label: "pricing",
      issue: "https://github.com/example/work/issues/1", sources: ["https://sources.example.test/notes"] };
    const result = await ok(add);
    assert.equal(result.tasks[0].id, taskId);
    assert.equal((await ok(add)).cursor, result.cursor);
    assert.equal((await call({ ...add, outcome: "Different task" })).status, 409);
    return { root, child, taskId, cursor: result.cursor };
  }
  return { f, call, ok, intent, project, deliveryCount: () => deliveries, submitted,
    removeAgentAccess: () => { revoked = true; }, revokeSession: () => { agentRevoked = true; },
    finishRun: () => { active = false; }, failWith: (status: number) => { fail = status; },
    dropReply: (drop: boolean) => { loseResponse = drop; },
  };
}

test("a connected owner maps, labels and delegates one canonical project task", async t => {
  const h = await fixture(t);
  const { root, child, taskId, cursor } = await h.project();
  const changed = await h.ok({ action: "node", id: child, cursor, parentId: null, title: "Pilot seats" });
  assert.equal(changed.tasks[0].nodeId, child);
  assert.equal((await h.call({ action: "node", id: root, cursor, parentId: child, title: "Lost update" })).status, 409);
  const delegate = { action: "delegate", cursor: changed.cursor, taskId, taskRevision: 0, intent: h.intent(h.f.botA) };
  assert.equal((await h.call({ ...delegate, forum: "another-project" })).status, 404);
  const alternate = { ...delegate, intent: h.intent(h.f.botB) };
  const competing = await Promise.all([h.call(delegate), h.call(alternate)]);
  assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
  const [winner, loser] = competing[0].ok ? [delegate, alternate] : [alternate, delegate];
  assert.equal(h.deliveryCount(), 1);
  const state = await h.ok(winner);
  assert.equal(h.deliveryCount(), 1);
  const run = state.ledger[0];
  assert.equal(run.taskId, taskId);
  assert.equal(run.requestedBy, h.f.owner.pub);
  const agentA = winner.intent.bot_id === h.f.botA;
  const enrolled = agentA ? "fixture-agent-a" : "fixture-agent-b";
  const other = agentA ? "fixture-agent-b" : "fixture-agent-a";
  assert.equal(run.delegate, agentA ? h.f.a.pub : h.f.b.pub);
  const resume = { action: "resume", taskId, since: 0 };
  const read = await h.call(resume, enrolled, false);
  assert.equal(read.status, 200);
  const payload = await read.text();
  const bytes = Buffer.byteLength(payload);
  t.diagnostic("Partner task resume bytes: " + bytes);
  assert.ok(bytes < 1500);
  const task = JSON.parse(payload);
  assert.equal(task.taskId, taskId);
  assert.equal(task.owner, h.f.owner.pub);
  assert.equal(task.delegate, run.delegate);
  assert.equal(task.taskRevision, 0);
  assert.equal(task.planeTaskId, run.planeTaskId);
  const delivered = { action: "resume", planeTaskId: run.planeTaskId, since: 0 };
  assert.deepEqual(await (await h.call(delivered, enrolled, false)).json(), task);
  assert.equal((await h.call(delivered, other, false)).status, 404);
  assert.deepEqual(task.branch.map((node: { id: string }) => node.id), [child]);
  assert.deepEqual(await (await h.call({ ...resume, since: task.cursor }, enrolled, false)).json(),
    { taskId, cursor: task.cursor, changed: false });
  assert.equal((await h.call(resume, other, false)).status, 404);

  const reassign = { ...loser, taskRevision: 1, cursor: state.cursor };
  assert.equal((await h.call(reassign)).status, 409);
  h.finishRun();
  await h.ok(reassign);
  assert.equal((await h.call(resume, enrolled, false)).status, 404);
  assert.equal((await h.call(delivered, enrolled, false)).status, 404);
  assert.equal((await h.call(resume, other, false)).status, 200);
  h.removeAgentAccess();
  assert.equal((await h.call(resume, other, false)).status, 403);
  h.revokeSession();
  assert.equal((await h.call(resume, other, false)).status, 403);
});

test("unknown delivery retries the same Plane intent and a refused intent releases its reservation", async t => {
  const h = await fixture(t);
  const { taskId, cursor } = await h.project();
  const body = { action: "delegate", taskId, cursor, taskRevision: 0, intent: h.intent(h.f.botA) };
  h.failWith(422);
  assert.equal((await h.call(body)).status, 422);
  const board = await h.ok({ action: "board" });
  assert.equal(board.ledger[0].status, "rejected");

  const retry = { ...body, cursor: board.cursor, taskRevision: board.tasks[0].revision, intent: h.intent(h.f.botA) };
  h.failWith(0);
  h.dropReply(true);
  assert.equal((await h.call(retry)).status, 503);
  assert.ok(h.submitted.has(retry.intent.source_task_id));
  assert.equal((await h.call(retry)).status, 409);
  for (let ticks = 0; ticks < 21; ticks++) h.f.tick();
  h.dropReply(false);
  const reloaded = await h.ok({ action: "board" });
  const rebuilt = squadProjectDelegationRequest(reloaded, reloaded.tasks[0], retry.intent);
  assert.equal(rebuilt.taskRevision, retry.taskRevision);
  assert.notEqual(reloaded.tasks[0].revision, rebuilt.taskRevision);
  const confirmed = await h.ok(rebuilt);
  assert.equal(h.submitted.size, 1);
  assert.equal(confirmed.ledger.at(-1).status, "accepted");
});

test("refresh after a stale cursor rebuilds the request when no reservation exists", async t => {
  const h = await fixture(t);
  const { taskId, child } = await h.project();
  const original = await h.ok({ action: "board" });
  const intent = h.intent(h.f.botA);
  const stale = squadProjectDelegationRequest(original, original.tasks[0], intent);
  await h.ok({ action: "node", id: child, title: "Updated", parentId: null, cursor: original.cursor });
  assert.equal((await h.call(stale)).status, 409);
  assert.equal(h.deliveryCount(), 0);
  const current = await h.ok({ action: "board" });
  assert.equal(current.ledger.length, 0);
  const refreshed = squadProjectDelegationRequest(current, current.tasks[0], intent);
  assert.equal(refreshed.cursor, current.cursor);
  assert.equal((await h.ok(refreshed)).ledger[0].taskId, taskId);
  assert.equal(h.deliveryCount(), 1);
});
