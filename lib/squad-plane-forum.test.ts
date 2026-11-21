import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { createSquadPlaneForum, squadPlaneTaskId } from "./squad-plane-forum";
import vectors from "./identity/vectors/forum-authority.json";

test("forum intake and control require current owner and roster access and return bound Plane status", async t => {
  const f = await forumBotFixture(t);
  const site = "https://forum.example.test";
  const plane = { origin: "https://plane.example.test", tenant: f.tenant,
    roster: { [f.botA]: f.a.pub }, controlCredential: "hm_fop_" + "a".repeat(64) };
  const base = { version: 1, bot_id: f.botA, source_task_id: randomUUID(),
    assignment_id: randomUUID(), session_id: randomUUID() };
  const task = { ...base, kind: "remote-agent", request_sha256: "a".repeat(64) };
  let calls = 0, remove = false, mismatch = false;
  const service = createSquadPlaneForum({
    siteOrigin: site, squad: { forumId: f.forum, owner: f.owner.pub, label: "Pilot" }, plane,
    config: { keys: [], pinnedIssuers: [], policy: vectors.context.policy },
    clock: f.now,
    authenticate: async request => ({ key: request.headers.get("x-test-key") ?? f.owner.pub }),
    read: async at => ({ completeThrough: at, rows: remove ? f.rows.slice(0, 1) : f.rows,
      history: { completeThrough: at, links: [], accounts: [f.owner, f.a, f.b].map(pair =>
        ({ principal: pair.pub, rotations: [], revocations: [], genesisEpubBindings: [] })) } }),
    fetch: async (url, init) => {
      calls++;
      assert.equal(new URL(String(url)).origin, plane.origin);
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      const browserControl = new URL(String(url)).pathname.endsWith("/control-current");
      assert.equal(headers.get("Authorization"), "Bearer " + (browserControl ? plane.controlCredential : "owner-plane-fixture"));
      assert.equal(headers.get("Cookie"), null);
      assert.equal(headers.get("X-Tenant-ID"), f.tenant);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.forum_id, f.forum);
      if (body.kind) assert.equal(body.principal, f.a.pub);
      return Response.json({
        ...base, task_id: squadPlaneTaskId(f.tenant, f.forum, base.source_task_id),
        tenant_id: f.tenant, session_id: mismatch ? randomUUID() : base.session_id,
        desired: body.action === "pause" ? "paused" : "running", status: "queued",
        forum: { id: f.forum, source_task_id: base.source_task_id, principal: f.a.pub, kind: task.kind },
      });
    },
  });
  const request = (body: object, key = f.owner.pub) => new Request(site + "/api/squad/pilot/plane", {
    method: "POST", headers: { origin: site, "content-type": "application/json", "x-test-key": key,
      authorization: "Bearer owner-plane-fixture", cookie: "fixture=site-only" }, body: JSON.stringify(body),
  });

  assert.equal((await service(request(task, f.a.pub), "tasks")).status, 403);
  assert.equal((await service(request({ ...task, bot_id: f.botB }), "tasks")).status, 403);
  assert.equal(calls, 0);
  assert.equal((await service(request(task), "tasks")).status, 200);
  const paused = await service(request({ ...base, action: "pause" }), "control");
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).desired, "paused");
  mismatch = true;
  assert.equal((await service(request(task), "tasks")).status, 503);
  remove = true;
  assert.equal((await service(request(task), "tasks")).status, 403);
  assert.equal(calls, 3);
  remove = false; mismatch = false;
  const list = await service(request({ version: 1 }), "bot-controls");
  assert.deepEqual(await list.json(), { bots: [{ id: f.botA, principal: f.a.pub }] });
  assert.equal((await service(request({ version: 1, bot_id: f.botA, action: "pause" }, f.a.pub), "bot-controls")).status, 403);
  const browserPaused = await service(request({ version: 1, bot_id: f.botA, action: "pause" }), "bot-controls");
  assert.deepEqual(await browserPaused.json(), { desired: "paused" });
  assert.equal(calls, 4);
});
