import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createSquadWorkbookPublisher } from "./squad-workbook";
import { createSquadPreviewPublisher, previewDraftTranscript } from "./squad-preview";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { parseAgentDelegation, type ResolutionContext } from "sociacl-ids";
import { createBotStatementAdmission } from "./forum-bot-statement-admission";
import { forumUpdateTranscript, VISOR_FORUM_STATUS_TEXT, type VerifiedForumUpdate } from "./forum-plane-update";
import { parseForumAuthority } from "./identity/forum-authority-records";
import { briefDigest, briefDraftTranscript, createSquadBriefPublisher } from "./squad-brief";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { openArtifactSignatures } from "./forum-visor-reporter";
import { signForumRecord } from "./forum-sign";
import { createIdentitySessions } from "./identity/sea-session";
import { readSeaSessionCookie, seaSessionCookieNames } from "./identity/sea-session-http";
import vectors from "./identity/vectors/forum-authority.json";
import { createSquadPlaneForum, squadPlaneTaskId } from "./squad-plane-forum";
import { approveSquadAgent, revokeSquadAgent, SQUAD_AGENT_SCOPE, type SquadAgentEnrollment } from "./squad-agent-enrollment";
import { createSquadAgentEnrollmentService } from "./squad-agent-enrollment-service";
import { createSquadProjectService } from "./squad-project-service";
import { squadProjectDelegationRequest } from "./squad-project-client";
import { createSquadProjectStore } from "./squad-project";
import { createSimulatedRecordStore } from "./visor-companion-set-store";

async function fixture(t: test.TestContext, fixtureCleanup?: true) {
  const f = await forumBotFixture(t);
  const origin = fixtureCleanup ? "https://test.s3r.ch" : "https://forum.example.test";
  const plane = { origin: "https://plane.example.test", tenant: f.tenant, roster: {
    [f.botA]: f.a.pub, [f.botB]: f.b.pub,
  } };
  const squad = { forumId: f.forum, owner: f.owner.pub, label: "Partner pilot" };
  const config = { keys: [], pinnedIssuers: [], policy: vectors.context.policy };
  const consumed = new Set<string>();
  const signedEnrollments: { kind: string; record: unknown }[] = [];
  const context: Omit<ResolutionContext, "now"> = { jwks: { keys: [] }, links: new Map(), revocations: [],
    pinnedIss: new Set(), policy: { ...config.policy, clockSkewSeconds: 0 }, history: () => ({ ok: false, reason: "missing-history" }) };
  const sessions = createIdentitySessions({ origin, secret: "squad-project-fixture-key".repeat(2), clock: f.now,
    consume: async id => {
      if (consumed.has(id)) return false;
      consumed.add(id);
      return true;
    },
    delegationSource: async (id, at) => {
      for (const row of signedEnrollments) {
        const parsed = row.kind === "delegation" && parseAgentDelegation(row.record);
        if (parsed && parsed.ok && parsed.value.id === id) return { completeThrough: at, delegation: parsed.value.delegation,
          rotations: [], context, revocations: signedEnrollments.filter(row => row.kind === "revocation").map(row => row.record) };
      }
      return null;
    },
  });
  const mintBrowserSession = async (pair: typeof f.owner) => {
    const challenge = await sessions.challenge(pair.pub);
    const signature = await signForumRecord(challenge, pair);
    assert.ok(signature);
    const session = await sessions.exchange(challenge, signature);
    assert.ok(session);
    return seaSessionCookieNames()[0] + "=" + session;
  };
  const browserSession = await mintBrowserSession(f.owner);
  const authenticate = (request: Request) => sessions.authenticate(readSeaSessionCookie(request) ?? "");
  let revoked = false, fail = 0, loseResponse = false, active = true;
  let deliveries = 0;
  const submitted = new Set<string>();
  const authority = {
    squad, config, plane, authenticate, clock: f.now,
    read: async (at: number) => ({ completeThrough: at, rows: revoked ? f.rows.slice(0, 1) : f.rows,
      history: { completeThrough: at, links: [], accounts: [f.owner, f.a, f.b].map(pair =>
        ({ principal: pair.pub, rotations: [], revocations: [], genesisEpubBindings: [] })) } }),
  };
  const enrollment = createSquadAgentEnrollmentService({
    pilot: { version: 1, origin, squad, plane, authority: config }, authenticate, clock: f.now, read: authority.read,
    journal: {
      read: async at => ({ fence: String(signedEnrollments.length), snapshot: { audience: origin, rows: [...signedEnrollments],
        completeThrough: at, history: { completeThrough: at, links: [], accounts: [] } } }),
      async append(fence, rows, guard) {
        guard();
        if (fence !== String(signedEnrollments.length)) return false;
        signedEnrollments.push(...rows as typeof signedEnrollments);
        return true;
      },
    },
  });
  async function manage<T>(body: object): Promise<T> {
    const response = await enrollment(new Request(origin + "/api/squad/pilot/enrollment", {
      method: "POST", headers: { Origin: origin, Cookie: browserSession, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, forum: f.forum }),
    }));
    assert.equal(response.status, 200);
    return response.json();
  }
  async function enroll(agent: typeof f.a) {
    const state = await manage<SquadAgentEnrollment>({ action: "list" });
    const record = approveSquadAgent(f.owner, state, origin, agent.pub);
    const { id } = await manage<{ id: string }>({ action: "approve", record });
    const challenge = await sessions.agentChallenge(id, [SQUAD_AGENT_SCOPE]);
    assert.ok(challenge);
    const proof = await signForumRecord(challenge, agent);
    assert.ok(proof);
    const token = await sessions.exchangeAgent(challenge, proof);
    assert.ok(token);
    return token;
  }
  const nativeTokens: Record<string, string> = { "fixture-agent-a": await enroll(f.a), "fixture-agent-b": await enroll(f.b) };
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
  const service = createSquadProjectService({ ...authority, origin, store, dispatch, fixtureCleanup, authenticateAgent: async request => {
    const token = request.headers.get("authorization")?.slice("Bearer ".length);
    return token ? sessions.authenticateAgent(token, [SQUAD_AGENT_SCOPE]) : null;
  } });
  const call = (body: object, credential = "plane-owner-fixture", browser = true) => service(new Request(origin + "/api/squad/pilot/project", {
    method: "POST", headers: { "Content-Type": "application/json",
      ...(!browser || ("action" in body && body.action === "delegate") ? { Authorization: "Bearer " + (browser ? credential : nativeTokens[credential] ?? credential) } : {}),
      ...(browser ? { Origin: origin, Cookie: browserSession } : {}) },
    body: JSON.stringify({ forum: f.forum, ...body }),
  }));
  const ok = async (body: object) => {
    const response = await call(body);
    assert.equal(response.status, 200);
    return response.json();
  };
  const intent = (bot: string) => ({ version: 1, bot_id: bot, source_task_id: randomUUID(), assignment_id: randomUUID(),
    session_id: randomUUID(), kind: "remote-agent", request_sha256: "1".repeat(64) });
  async function project(runId?: string) {
    const root = randomUUID(), child = runId ? root : randomUUID(), taskId = randomUUID();
    await ok({ action: "node", id: root, title: runId ? "Squad CI " + runId : "Partner", parentId: null, cursor: 0 });
    if (!runId) await ok({ action: "node", id: child, title: "Requirements", parentId: root, cursor: 1 });
    const add = { action: "create-task", id: taskId, nodeId: child, outcome: "Confirm 10 pilot seats",
      label: runId ? "partner-pilot" : "pricing",
      issue: "https://github.com/example/work/issues/1", sources: ["https://sources.example.test/notes"] };
    const result = await ok(add);
    assert.equal(result.tasks[0].id, taskId);
    assert.equal((await ok(add)).cursor, result.cursor);
    assert.equal((await call({ ...add, outcome: "Different task" })).status, 409);
    return { root, child, taskId, cursor: result.cursor };
  }
  return { f, call, ok, intent, project, origin, authority, store, mintBrowserSession, deliveryCount: () => deliveries, submitted,
    removeAgentAccess: () => { revoked = true; },
    revokeSession: async () => {
      const state = await manage<SquadAgentEnrollment>({ action: "list" });
      for (const grant of state.grants)
        await manage({ action: "revoke", record: revokeSquadAgent(f.owner, state, grant.id) });
    },
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
  await h.revokeSession();
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

test("delivered agent artifacts stay editable and reviewable by exact revision", async t => {
  const h = await fixture(t, true);
  const runId = "42-1-gateway-test";
  const { taskId, cursor, root } = await h.project(runId);
  const intent = h.intent(h.f.botA);
  const assigned = await h.ok({ action: "delegate", cursor, taskId, taskRevision: 0, intent });
  const { planeTaskId } = assigned.ledger[0];
  const { f } = h;
  const signFor = (privateKey: string, bytes: Uint8Array) => Buffer.from(p256.sign(bytes, Buffer.from(privateKey, "base64url"),
    { prehash: true, format: "compact" })).toString("base64url");
  const sign = (bytes: Uint8Array) => signFor(f.a.priv, bytes);
  const journal = new DatabaseSync(":memory:");
  t.after(() => journal.close());
  const signArtifact = openArtifactSignatures(journal, sign);
  async function deliveryFor(binding: typeof intent, deliveryTaskId: string) {
    const actor = binding.bot_id === f.botA ? f.a : f.b;
    const offset = f.rows.length;
    const statement = await f.signed(["update", f.tenant, deliveryTaskId, VISOR_FORUM_STATUS_TEXT.completed], actor);
    const object = { ...(f.rows[offset].record as object), issuedAt: statement.issuedAt, sig: "pending" };
    const parsed = parseForumAuthority("object", object);
    assert.ok(parsed);
    object.sig = signFor(actor.priv, parsed.bytes);
    f.rows[offset] = { kind: "object", soul: parsed.soul, record: object };
    const fields = { botId: binding.bot_id, assignmentId: binding.assignment_id, sessionId: binding.session_id, taskId: deliveryTaskId,
      deliveryId: randomUUID(), sequence: 1, signature: statement.signature };
    const updateScope = { ...fields, tenant: f.tenant, forumId: f.forum, principal: actor.pub,
      statementId: statement.id, status: "completed" as const };
    const proof = { ...fields, attestation: signFor(actor.priv, forumUpdateTranscript(updateScope)) };
    return { proof, verified: { ...updateScope, attestation: proof.attestation } satisfies VerifiedForumUpdate, rows: f.rows.slice(offset) };
  }
  const first = await deliveryFor(intent, planeTaskId);
  const { proof, verified } = first;
  const deliveries = new Set<string>([proof.deliveryId]);
  const draft = { artifactId: randomUUID(), revisionId: randomUUID(), taskId, base: null,
    markdown: "# Partner brief\n10 seats for a 30-day pilot.\n" };
  const signedDraft = signArtifact({ kind: "brief", draft }, verified);
  const reporterCookie = await h.mintBrowserSession(f.a);
  let revokeBeforeSave = false, deliveryAllowed = false, aclRevoked = false, checked = 0;
  const admission = createBotStatementAdmission({
    ...h.authority, origin: h.origin,
    source: { read: async at => {
      const snapshot = await h.authority.read(at);
      return { snapshot: aclRevoked ? { ...snapshot, rows: snapshot.rows.slice(0, 1) } : snapshot, fence: "fixture" };
    }, append: async () => { throw Error("Unexpected unguarded append"); } },
    planeUpdates: { tenant: f.tenant, roster: h.authority.plane.roster,
      async commit({ update, guard }) {
        guard();
        assert.ok(deliveries.has(update.deliveryId));
        checked++;
        if (!deliveryAllowed) return "refused";
        aclRevoked = revokeBeforeSave;
        return "committed";
      } },
    saveBrief: createSquadBriefPublisher(h.store, f.now),
    saveWorkbook: createSquadWorkbookPublisher(h.store, f.now),
    savePreview: createSquadPreviewPublisher(h.store, f.now),
  });
  const publishArtifact = (kind: "brief" | "workbook" | "preview", value: object, delivery = first, cookie = reporterCookie) => admission(new Request(h.origin + "/api/squad/pilot/plane/" + kind, {
    method: "POST", headers: { Origin: h.origin, "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ version: 1, forumId: f.forum, owner: f.owner.pub, evaluatedAt: f.now(),
      rows: delivery.rows, update: delivery.proof, [kind]: value }),
  }), kind === "brief" ? "plane-brief" : kind === "workbook" ? "plane-workbook" : "plane-preview");
  const publish = (brief: object) => publishArtifact("brief", brief);
  const read = { action: "brief-read", taskId, revisionId: null };
  assert.equal((await publish({ ...signedDraft, markdown: "Modified without a signature" })).status, 403);
  assert.equal(checked, 0);
  assert.equal((await publish(signedDraft)).status, 403);
  assert.equal((await h.ok(read)).brief, null);
  deliveryAllowed = true;
  revokeBeforeSave = true;
  assert.equal((await publish(signedDraft)).status, 403);
  assert.equal((await h.ok(read)).brief, null);
  aclRevoked = false;
  revokeBeforeSave = false;
  assert.equal((await publish(signedDraft)).status, 200);
  assert.equal((await publish(signedDraft)).status, 200);

  const initial = (await h.ok(read)).brief;
  assert.equal(initial.id, draft.artifactId);
  assert.equal(initial.history.length, 1);
  assert.equal(initial.selected.author, f.a.pub);
  assert.equal(initial.selected.markdown, draft.markdown);
  assert.equal(initial.selected.sha256, briefDigest(draft.markdown));
  assert.deepEqual(initial.selected.sources, ["https://sources.example.test/notes"]);
  assert.deepEqual(initial.selected.run, { taskId: planeTaskId, deliveryId: proof.deliveryId });

  const note = { action: "brief-review", taskId, id: randomUUID(), revisionId: draft.revisionId,
    kind: "approve", lines: [2, 2], text: "Confirm the supplied pilot facts." };
  assert.equal((await h.ok(note)).brief.annotations.length, 1);
  assert.equal((await h.ok(note)).brief.annotations.length, 1);
  const revise = { action: "brief-revise", taskId, revisionId: randomUUID(), base: draft.revisionId,
    markdown: draft.markdown + "\nOwner confirmed the pilot scope.\n" };
  const concurrent = { ...revise, revisionId: randomUUID(), markdown: draft.markdown + "Another edit.\n" };
  const results = await Promise.all([h.call(revise), h.call(concurrent)]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  const winner = results[0].ok ? revise : concurrent;
  const edited = (await h.ok(winner)).brief;
  assert.equal(edited.history.length, 2);
  assert.equal(edited.id, draft.artifactId);
  assert.equal(edited.selected.author, f.owner.pub);
  assert.equal(edited.selected.parent, draft.revisionId);
  assert.equal(edited.selected.run, null);
  assert.deepEqual(edited.annotations, []);
  const anotherDraft = { ...draft, revisionId: randomUUID(), base: winner.revisionId };
  const replacement = { ...anotherDraft, signature: sign(briefDraftTranscript(verified, anotherDraft)) };
  assert.equal((await publish(replacement)).status, 409);
  assert.equal((await publish(signedDraft)).status, 200);
  assert.equal((await h.ok(read)).brief.current, winner.revisionId);
  const old = (await h.ok({ ...read, revisionId: draft.revisionId })).brief;
  assert.deepEqual(old.annotations[0].lines, [2, 2]);
  for (const version of [draft, winner]) {
    const response = await h.call({ ...read, action: "brief-export", revisionId: version.revisionId });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.match(response.headers.get("content-disposition") ?? "", new RegExp(version.revisionId));
    assert.equal(await response.text(), version.markdown);
  }
  assert.equal((await h.call({ ...read, forum: "wrong-project" })).status, 404);
  assert.equal((await h.call(read, "fixture-agent-a", false)).status, 200);
  assert.equal((await h.call(read, "fixture-agent-b", false)).status, 404);
  const pricing = { quantity: 10, unitPriceCents: 12_000, discountBps: 0 };
  const workbook = { artifactId: randomUUID(), revisionId: randomUUID(), taskId, inputs: pricing };
  const signedWorkbook = signArtifact({ kind: "workbook", draft: workbook }, verified);
  const readWorkbook = { action: "workbook-read", taskId, revisionId: null };
  assert.equal((await publishArtifact("workbook", { ...signedWorkbook, inputs: { ...pricing, discountBps: 1 } })).status, 403);
  revokeBeforeSave = true;
  assert.equal((await publishArtifact("workbook", signedWorkbook)).status, 403);
  assert.equal((await h.ok(readWorkbook)).workbook, null);
  aclRevoked = false;
  revokeBeforeSave = false;
  assert.equal((await publishArtifact("workbook", signedWorkbook)).status, 200);
  const initialWorkbook = (await h.ok(readWorkbook)).workbook;
  assert.equal(initialWorkbook.id, workbook.artifactId);
  assert.equal(initialWorkbook.totalCents, 120_000);
  assert.equal(initialWorkbook.selected.author, f.a.pub);
  assert.deepEqual(initialWorkbook.selected.inputs, pricing);
  assert.deepEqual(initialWorkbook.selected.sources, ["https://sources.example.test/notes"]);
  assert.equal(initialWorkbook.selected.run.deliveryId, proof.deliveryId);
  const comment = { action: "workbook-comment", taskId, revisionId: workbook.revisionId, id: randomUUID(),
    sheet: "Pricing", range: "B4:B5", text: "Confirm pricing assumptions." };
  assert.equal((await h.call({ ...comment, range: "B6" })).status, 400);
  assert.equal((await h.ok(comment)).workbook.comments.length, 1);
  assert.equal((await h.ok(comment)).workbook.comments.length, 1);

  const readPreview = { action: "preview-read", taskId, revisionId: null };
  const preview = { artifactId: randomUUID(), revisionId: randomUUID(), taskId, base: null,
    briefRevisionId: winner.revisionId, workbookRevisionId: workbook.revisionId,
    copy: { title: "Partner pilot", summary: "Plan for 10 seats & a 30-day pilot.",
      highlights: ["Treat <em> as text."], nextStep: "Confirm the pilot scope." } };
  const signedPreview = signArtifact({ kind: "preview", draft: preview }, verified);
  const wrongInput = { ...preview, workbookRevisionId: randomUUID() };
  assert.equal((await publishArtifact("preview", { ...wrongInput, signature: sign(previewDraftTranscript(verified, wrongInput)) })).status, 404);
  assert.equal((await publishArtifact("preview", { ...signedPreview, copy: { ...preview.copy, title: "Changed copy" } })).status, 403);
  revokeBeforeSave = true;
  assert.equal((await publishArtifact("preview", signedPreview)).status, 403);
  assert.equal((await h.ok(readPreview)).preview, null);
  aclRevoked = false;
  revokeBeforeSave = false;
  assert.equal((await publishArtifact("preview", signedPreview)).status, 200);
  const originalPreview = (await h.ok(readPreview)).preview;
  assert.equal(originalPreview.newerBrief, false);
  assert.equal(originalPreview.newerWorkbook, false);
  assert.equal(originalPreview.owner, f.owner.pub);
  assert.equal(originalPreview.selected.author, f.a.pub);
  assert.deepEqual(originalPreview.selected.inputs.workbook, { artifactId: workbook.artifactId,
    revisionId: workbook.revisionId, author: f.a.pub, sheet: "Pricing", cell: "B5", assumptions: pricing, cents: 120_000 });
  assert.equal(originalPreview.selected.inputs.brief.revisionId, winner.revisionId);
  assert.match(originalPreview.selected.html, /id="quote">\$1,200\.00/);
  assert.match(originalPreview.selected.html, /Treat &lt;em&gt; as text/);
  assert.match(originalPreview.selected.html, /content="default-src 'none';.*form-action 'none'/);

  const priceEdit = { action: "workbook-revise", taskId, revisionId: randomUUID(), base: workbook.revisionId,
    inputs: { ...pricing, discountBps: 1000 } };
  for (const inputs of [{ ...pricing, quantity: 0 }, { ...pricing, unitPriceCents: 1.5 },
    { ...pricing, discountBps: 10_001 }, { ...pricing, formula: "extra" }]) {
    assert.equal((await h.call({ ...priceEdit, inputs })).status, 400);
  }
  const staleEdit = { ...priceEdit, revisionId: randomUUID() };
  const priceResults = await Promise.all([h.call(priceEdit), h.call(staleEdit)]);
  assert.deepEqual(priceResults.map(response => response.status).sort(), [200, 409]);
  const savedPrice = priceResults[0].ok ? priceEdit : staleEdit;
  const editedWorkbook = (await h.ok(savedPrice)).workbook;
  assert.equal(editedWorkbook.id, workbook.artifactId);
  assert.equal(editedWorkbook.history.length, 2);
  assert.equal(editedWorkbook.selected.author, f.owner.pub);
  assert.equal(editedWorkbook.selected.parent, workbook.revisionId);
  assert.deepEqual(editedWorkbook.selected.inputs, savedPrice.inputs);
  assert.deepEqual(editedWorkbook.comments, []);
  assert.equal(editedWorkbook.totalCents, 108_000);
  assert.equal((await publishArtifact("workbook", signedWorkbook)).status, 200);
  assert.equal((await h.ok(readWorkbook)).workbook.current, savedPrice.revisionId);
  const historical = (await h.ok({ ...readWorkbook, revisionId: workbook.revisionId })).workbook;
  assert.equal(historical.comments[0].range, "B4:B5");
  assert.equal(historical.totalCents, 120_000);
  assert.equal((await h.call(readWorkbook, "fixture-agent-a", false)).status, 200);
  assert.equal((await h.call(readWorkbook, "fixture-agent-b", false)).status, 404);
  assert.equal((await h.call({ ...readWorkbook, forum: "wrong-project" })).status, 404);
  for (const [version, discount, total] of [[workbook, "0.0000", "1200.00"], [savedPrice, "0.1000", "1080.00"]] as const) {
    const response = await h.call({ ...readWorkbook, action: "workbook-export", revisionId: version.revisionId });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.match(response.headers.get("content-disposition") ?? "", new RegExp(version.revisionId + "\\.xlsx"));
    const xlsx = Buffer.from(await response.arrayBuffer());
    const reopened = JSON.parse(execFileSync("python3", ["-c", inspectWorkbook], { input: xlsx, encoding: "utf8" }));
    assert.deepEqual(reopened, { B2: ["10", null], B3: ["120.00", null], B4: [discount, null],
      B5: [total, "ROUND(B2*B3*(1-B4),2)"] });
  }
  const newerBrief = { ...revise, base: winner.revisionId, revisionId: randomUUID(), markdown: "# Confirmed pilot scope" };
  await h.ok(newerBrief);
  const outdated = (await h.ok(readPreview)).preview;
  assert.equal(outdated.newerBrief, true);
  assert.equal(outdated.newerWorkbook, true);
  assert.equal(outdated.selected.html, originalPreview.selected.html);
  const next = { ...preview, base: preview.revisionId, revisionId: randomUUID(),
    briefRevisionId: newerBrief.revisionId, workbookRevisionId: savedPrice.revisionId };
  assert.equal((await publishArtifact("preview", { ...next, signature: sign(previewDraftTranscript(verified, next)) })).status, 409);

  const board = await h.ok({ action: "board" });
  const nextIntent = h.intent(f.botB);
  h.finishRun();
  const nextAssignment = await h.ok({ action: "delegate", cursor: board.cursor, taskId,
    taskRevision: board.tasks[0].revision, intent: nextIntent });
  const second = await deliveryFor(nextIntent, nextAssignment.ledger.at(-1).planeTaskId);
  deliveries.add(second.proof.deliveryId);
  const secondJournal = new DatabaseSync(":memory:");
  t.after(() => secondJournal.close());
  const secondSigner = openArtifactSignatures(secondJournal, bytes => signFor(f.b.priv, bytes));
  const signedSecond = secondSigner({ kind: "preview", draft: next }, second.verified);
  const secondCookie = await h.mintBrowserSession(f.b);
  assert.equal((await h.call({ ...readWorkbook, revisionId: savedPrice.revisionId }, "fixture-agent-a", false)).status, 404);
  const successorRead = await h.call({ ...readWorkbook, revisionId: savedPrice.revisionId }, "fixture-agent-b", false);
  assert.equal(successorRead.status, 200);
  assert.equal((await successorRead.json()).workbook.selected.id, savedPrice.revisionId);
  assert.equal((await publishArtifact("preview", signedSecond, second)).status, 403);
  assert.equal((await publishArtifact("preview", signedSecond, second, secondCookie)).status, 200);
  assert.equal((await publishArtifact("preview", signedSecond, second, secondCookie)).status, 200);
  const refreshed = (await h.ok(readPreview)).preview;
  assert.equal(refreshed.history.length, 2);
  assert.equal(refreshed.current, next.revisionId);
  assert.equal(refreshed.newerBrief, false);
  assert.equal(refreshed.newerWorkbook, false);
  assert.equal(refreshed.selected.parent, preview.revisionId);
  assert.equal(refreshed.selected.inputs.brief.revisionId, newerBrief.revisionId);
  assert.deepEqual(refreshed.selected.inputs.workbook, { artifactId: workbook.artifactId,
    revisionId: savedPrice.revisionId, author: f.owner.pub, sheet: "Pricing", cell: "B5", assumptions: savedPrice.inputs, cents: 108_000 });
  assert.match(refreshed.selected.html, /id="quote">\$1,080\.00/);
  assert.equal((await h.ok({ ...readPreview, revisionId: preview.revisionId })).preview.selected.html, originalPreview.selected.html);
  const html = await h.call({ ...readPreview, revisionId: preview.revisionId, action: "preview-export" });
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.match(html.headers.get("content-security-policy") ?? "", /^sandbox; default-src 'none';.*form-action 'none'/);
  assert.equal(await html.text(), originalPreview.selected.html);
  assert.equal(refreshed.selected.author, f.b.pub);
  assert.equal((await h.call(readPreview, "fixture-agent-a", false)).status, 404);
  assert.equal((await h.call({ ...readPreview, forum: "another-project" })).status, 404);
  h.removeAgentAccess();
  assert.equal((await h.call(read, "fixture-agent-a", false)).status, 403);
  assert.equal((await h.call(readWorkbook, "fixture-agent-a", false)).status, 403);
  assert.equal((await h.call(readPreview, "fixture-agent-a", false)).status, 403);

  const final = await h.ok({ action: "board" });
  const cleanup = { action: "cleanup-fixture", runId, cursor: final.cursor, nodeId: root, taskId };
  assert.equal((await h.call({ ...cleanup, runId: "43-1-gateway-test" })).status, 409);
  assert.equal((await h.call({ ...cleanup, cursor })).status, 409);
  assert.equal((await h.call(cleanup, "fixture-agent-b", false)).status, 403);
  assert.equal((await h.ok(readPreview)).preview.history.length, 2);
  assert.deepEqual(await h.ok(cleanup), { removed: true });
  assert.deepEqual(await h.ok(cleanup), { removed: true });
  const removed = await h.store.read(new AbortController().signal);
  assert.equal(removed.etag, null);
  assert.equal(removed.project.cursor, 0);
});

test("fixture teardown refuses a project with unrelated data and requires explicit TEST setup", async t => {
  const h = await fixture(t, true);
  const runId = "42-1-gateway-test";
  const { root, taskId, cursor } = await h.project(runId);
  const state = await h.ok({ action: "node", id: randomUUID(), title: "Retained work", parentId: null, cursor });
  const cleanup = { action: "cleanup-fixture", runId, cursor: state.cursor, nodeId: root, taskId };
  assert.equal((await h.call(cleanup)).status, 409);
  assert.deepEqual((await h.ok({ action: "board" })).nodes, state.nodes);
  const ordinary = await fixture(t);
  assert.equal((await ordinary.call(cleanup)).status, 404);
});

const inspectWorkbook = `
import io, json, sys, xml.etree.ElementTree as ET, zipfile
ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    assert archive.testzip() is None
    contents = ET.fromstring(archive.read("[Content_Types].xml"))
    assert any(part.get("PartName") == "/xl/worksheets/sheet1.xml" for part in contents)
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    assert workbook.find(".//" + ns + "sheet").get("name") == "Pricing"
    sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
    assert sheet.find(ns + "sheetProtection") is None
    styles = ET.fromstring(archive.read("xl/styles.xml"))
    assert styles.find(ns + "cellXfs").get("count") == "3"
    print(json.dumps({cell.get("r"): [cell.findtext(ns + "v"), cell.findtext(ns + "f")]
                      for cell in sheet.iter(ns + "c") if cell.get("r").startswith("B")}))
`;
