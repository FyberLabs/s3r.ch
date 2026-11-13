import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { createForumBotWorker, type BotExecutionStatus } from "./forum-bot-worker";
import { openForumBotOutbox } from "./forum-bot-outbox";
import type { LocalBotApproval } from "./forum-bot-local-access";
async function setup(t: test.TestContext) {
  const f = await forumBotFixture(t), task = f.task(), signed = await f.signed(task), channel = f.open();
  const scope = { tenant: f.tenant, forum: f.forum, bot: f.botB, principal: f.b.pub };
  let grant: LocalBotApproval | null = { version: 1, ...scope, handle: task[4], session: randomUUID(), expires: task[5], revoked: false,
    task: { steps: [{ tool: "view", arguments: {} }] }, artifactReaders: [] };
  let submissions = 0, cancellations = 0, exports = 0, failSubmit = false, fresh = true;
  const id = randomUUID(), session = grant.session;
  let state: BotExecutionStatus["status"] = "running";
  const dir = mkdtempSync(join(tmpdir(), "bot-worker-")); chmodSync(dir, 0o700);
  const outbox = openForumBotOutbox(join(dir, "outbox.db"), scope);
  t.after(() => { outbox.close(); rmSync(dir, { recursive: true, force: true }); });
  const worker = createForumBotWorker({ tenant: f.tenant, channel, approvals: { read: () => grant },
    artifacts: { put() { exports++; return randomUUID(); }, read: async () => { throw Error("not authorized"); }, revoke() {} },
    refresh: async () => { if (!fresh) throw Error("source unavailable"); await f.refresh(); return true; },
    publish: async message => outbox.enqueue(message), clock: () => f.now() * 1000,
    executor: {
      consent: async () => ({ running: true, resume: 7 }),
      submit: async (approval, until, resume) => { submissions++; assert.equal(approval, grant); assert.equal(resume, 7);
        assert.ok(until > f.now() * 1000 && until <= f.now() * 1000 + 15000);
        if (failSubmit) throw Error("uncertain submission"); return { id }; },
      status: async () => ({ id, session, status: state, completed_steps: state === "completed" ? 1 : 0, total_steps: 1, results: [] }),
      cancel: async () => { cancellations++; if (state !== "completed") state = "cancelled"; },
    } });
  return { f, task, signed, channel, worker, outbox, dir, scope,
    submissions: () => submissions, cancellations: () => cancellations, exports: () => exports,
    replaceApproval() { grant = { ...grant!, task: { steps: [{ tool: "type_text", arguments: { text: "new task" } }] }, artifactReaders: [f.owner.pub] }; },
    revoke() { grant = null; }, loseAuthority() { fresh = false; }, failSubmit() { failSubmit = true; }, complete() { state = "completed"; } };
}
test("worker dispatches only the approved reference once and durably reports actual completion", async t => {
  const s = await setup(t); assert.equal(await s.worker.deliver([s.signed]), "stored");
  assert.equal(await s.worker.deliver([s.signed]), "duplicate");
  await s.worker.tick(); assert.equal(s.submissions(), 1); assert.match(s.outbox.next()!.body, /ack/);
  s.complete(); await s.worker.tick(); assert.equal(s.channel.status(s.task[2]), "completed");
  await s.worker.deliver([s.signed]); await s.worker.tick(); assert.equal(s.submissions(), 1);
});
test("revoked approval or failed authority refresh cancels active local work", async t => {
  for (const revoke of ["revoke", "loseAuthority"] as const) {
    const s = await setup(t); await s.worker.deliver([s.signed]); await s.worker.tick();
    s[revoke](); await s.worker.tick(); assert.equal(s.cancellations(), 1); assert.equal(s.channel.status(s.task[2]), "cancelled");
  }
});
test("uncertain submission is never retried and active signed cancellation reaches the executor", async t => {
  const s = await setup(t); await s.worker.deliver([s.signed]); s.failSubmit();
  await assert.rejects(s.worker.tick(), /uncertain/); await s.worker.tick(); assert.equal(s.submissions(), 1);
  assert.equal(s.channel.status(s.task[2]), "claimed");
  const other = await setup(t); await other.worker.deliver([other.signed]); await other.worker.tick();
  await other.worker.event(await other.f.signed(["cancel", other.f.tenant, other.task[2]]));
  await other.worker.tick(); assert.equal(other.channel.status(other.task[2]), "cancelled"); assert.equal(other.cancellations(), 1);
});
test("outbox retains identical prepared messages across restart and refuses rebinding", async t => {
  const s = await setup(t); await s.worker.deliver([s.signed]); await s.worker.tick();
  const first = s.outbox.next()!, node = { id: first.id, author: s.scope.principal, body: first.body, sig: "SEA-fixed" };
  s.outbox.stage(first.id, node);
  const second = openForumBotOutbox(join(s.dir, "outbox.db"), s.scope);
  try {
    assert.deepEqual(second.next()?.node, node);
    second.enqueue(["ack", s.scope.tenant, s.task[2]]); assert.equal(second.next()?.id, first.id);
    assert.throws(() => second.stage(first.id, { ...node, sig: "different" }), /already signed/);
    second.sent(first.id); assert.equal(second.next(), null);
  } finally { second.close(); }
  assert.throws(() => openForumBotOutbox(join(s.dir, "outbox.db"), { ...s.scope, tenant: randomUUID() }), /scope differs/);
});

test("one user's delegated chain runs once in each independently scoped worker", async t => {
  const f = await forumBotFixture(t), root = f.task(f.botA), child = f.task(f.botB, root[2]);
  const first = await f.signed(root), second = await f.signed(child, f.a);
  const reports: unknown[][] = [[], []], calls = [0, 0], cancelled = [false, false];
  const workers = [root, child].map((task, index) => {
    const channel = f.open(task[3]), session = randomUUID(), id = randomUUID();
    const approval: LocalBotApproval = { version: 1, tenant: f.tenant, forum: f.forum, bot: task[3],
      principal: index === 0 ? f.a.pub : f.b.pub, handle: task[4], session, expires: task[5], revoked: false,
      task: { steps: [{ tool: "view", arguments: {} }] }, artifactReaders: [] };
    const worker = createForumBotWorker({ tenant: f.tenant, channel, clock: () => f.now() * 1000,
      approvals: { read: handle => handle === approval.handle ? approval : null },
      artifacts: { put() { throw Error("not shared"); }, read: async () => { throw Error("not shared"); }, revoke() {} },
      refresh: async () => { await f.refresh(); return true; }, publish: async report => { reports[index].push(report); },
      executor: { consent: async () => ({ running: true, resume: index + 1 }),
        submit: async (grant, _until, resume) => { assert.equal(grant.session, session); assert.equal(resume, index + 1); calls[index]++; return { id }; },
        status: async () => ({ id, session, status: cancelled[index] ? "cancelled" : "completed", completed_steps: 1, total_steps: 1, results: [] }),
        cancel: async () => { cancelled[index] = true; } } });
    return { worker, channel };
  });
  await workers[0].worker.deliver([first]); await workers[1].worker.deliver([first, second]);
  await workers[0].worker.tick(); await workers[1].worker.tick();
  await workers[0].worker.tick(); await workers[1].worker.tick();
  assert.deepEqual(calls, [1, 1]);
  assert.equal(workers[0].channel.status(root[2]), "completed"); assert.equal(workers[1].channel.status(child[2]), "completed");
  assert.deepEqual(reports.map(rows => rows.map(row => (row as string[])[0])), [["ack", "result"], ["ack", "result"]]);
  await workers[0].worker.deliver([first]); await workers[1].worker.deliver([first, second]);
  await workers[0].worker.tick(); await workers[1].worker.tick(); assert.deepEqual(calls, [1, 1]);
  const foreign = await f.signed(f.task(f.botB), f.owner, f.forum.slice(0, -32) + "b".repeat(32));
  await assert.rejects(workers[1].worker.deliver([foreign])); assert.deepEqual(calls, [1, 1]);
});

test("replacement approval cannot share an already completed private task", async t => {
  const s = await setup(t); await s.worker.deliver([s.signed]); await s.worker.tick();
  s.complete(); s.replaceApproval(); await s.worker.tick();
  assert.equal(s.cancellations(), 1); assert.equal(s.channel.status(s.task[2]), "completed"); assert.equal(s.exports(), 0);
});
