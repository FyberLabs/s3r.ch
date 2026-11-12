import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openForumBotInbox, type BotInboxTask } from "./forum-bot-inbox";

function fixture(t: test.TestContext, capacity = 10) {
  const directory = mkdtempSync(join(tmpdir(), "forum-bot-")); chmodSync(directory, 0o700);
  const input = { path: join(directory, "inbox.sqlite"), scope: { tenant: randomUUID(), forum: "forum-fixture", bot: randomUUID(), principal: "independent-bot-principal" },
    authorize: () => true, clock: () => 1000, capacity };
  const connections: ReturnType<typeof openForumBotInbox>[] = [];
  const open = (patch = {}) => { const db = openForumBotInbox({ ...input, ...patch }); connections.push(db); return db; };
  t.after(() => { for (const db of connections) { try { db.close(); } catch {} } rmSync(directory, { recursive: true, force: true }); });
  const task = (): BotInboxTask => ({ id: randomUUID(), message: "stmt_" + randomUUID(), sender: "verified-sender", handle: randomUUID(), expires: 1100 });
  return { input, open, task, directory };
}

test("durable duplicates and claims survive reconnection without replay", t => {
  const f = fixture(t), a = f.open(), task = f.task();
  assert.equal(a.receive(task), "stored"); assert.equal(a.receive({ ...task }), "duplicate");
  assert.deepEqual(a.claim(task.id), task); a.close();
  const b = f.open(); assert.equal(b.receive(task), "duplicate");
  assert.equal(b.status(task.id), "unknown"); assert.equal(b.claim(task.id), null);
  assert.throws(() => b.finish(task.id, "completed"), /not claimed/);
});
test("two connections dispatch once and only the claiming process finishes", t => {
  const f = fixture(t), a = f.open(), b = f.open(), task = f.task(); a.receive(task);
  assert.deepEqual(a.claim(task.id), task); assert.equal(b.claim(task.id), null);
  assert.throws(() => b.finish(task.id, "completed")); a.finish(task.id, "completed");
  assert.equal(b.status(task.id), "completed"); assert.equal(b.receive(task), "duplicate");
});
test("fresh authority gates receive, dispatch and cancellation", t => {
  const f = fixture(t); let allow = true;
  const a = f.open({ authorize: () => allow }), task = f.task(); a.receive(task); allow = false;
  assert.throws(() => a.receive(task), /authority/); assert.throws(() => a.claim(task.id), /authority/);
  assert.throws(() => a.cancel(task.id), /authority/); assert.equal(a.status(task.id), "pending");
  allow = true; assert.equal(a.cancel(task.id), true); assert.equal(a.claim(task.id), null);
});
test("scope mismatch, message reuse and task mutation are refused", t => {
  const f = fixture(t), a = f.open(), task = f.task(); a.receive(task);
  for (const key of ["tenant", "forum", "bot", "principal"] as const)
    assert.throws(() => f.open({ scope: { ...f.input.scope, [key]: randomUUID() } }), /scope differs/);
  for (const change of [{ handle: randomUUID() }, { id: randomUUID() }, { message: "other" }])
    assert.throws(() => a.receive({ ...task, ...change }), /Conflicting/);
});
test("expiry and capacity do not discard the replay floor", t => {
  const f = fixture(t, 1); let now = 1000;
  const a = f.open({ clock: () => now }), task = f.task(); a.receive(task);
  assert.throws(() => a.receive(f.task()), /full/); now = 1100;
  assert.equal(a.claim(task.id), null); assert.equal(a.status(task.id), "expired");
  assert.equal(a.receive(task), "duplicate");
});
test("private paths and bounded handles are required", t => {
  const f = fixture(t), a = f.open();
  assert.throws(() => a.receive({ ...f.task(), handle: "https://example.test/private" }), /Invalid/);
  assert.throws(() => a.receive({ ...f.task(), expires: 5001 }), /deadline/);
  const link = join(f.directory, "link"); symlinkSync(f.input.path, link);
  assert.throws(() => f.open({ path: link }), /private/);
  chmodSync(f.input.path, 0o644); assert.throws(() => f.open(), /private/);
  chmodSync(f.directory, 0o755); assert.throws(() => f.open(), /private/);
});

test("authorization time cannot extend the stored task deadline", t => {
  const f = fixture(t); let at = 1000;
  const a = f.open({ clock: () => at, authorize: (_task: BotInboxTask, operation: string) => {
    if (operation === "dispatch") at = 1100;
    return true;
  } });
  const task = f.task(); a.receive(task);
  assert.equal(a.claim(task.id), null); assert.equal(a.status(task.id), "expired");
});

test("cursor and task commit together and stale writers cannot skip messages", t => {
  const f = fixture(t), a = f.open(), first = f.task(), next = f.task();
  assert.equal(a.cursor(), null);
  assert.equal(a.receive(first, { before: null, after: "page-1" }), "stored");
  assert.equal(a.receive(first, { before: null, after: "page-1" }), "duplicate");
  assert.throws(() => a.receive(next, { before: null, after: "page-2" }), /checkpoint changed/);
  assert.equal(a.status(next.id), null); assert.equal(a.cursor(), "page-1");
  a.close(); const b = f.open(); assert.equal(b.cursor(), "page-1");
  assert.equal(b.receive(next, { before: "page-1", after: "page-2" }), "stored");
  assert.equal(b.cursor(), "page-2");
  assert.throws(() => b.receive({ ...first, handle: randomUUID() }, { before: "page-2", after: "page-3" }), /Conflicting/);
  assert.equal(b.cursor(), "page-2");
});

test("authorization requires literal true and receives the immutable stored scope", t => {
  const f = fixture(t);
  for (const verdict of [Promise.resolve(true), 1, "allowed", null]) {
    const denied = f.open({ authorize: () => verdict });
    assert.throws(() => denied.receive(f.task()), /authority/);
  }
  const expected = { ...f.input.scope }; let observed: unknown;
  const a = f.open({ authorize: (_task: BotInboxTask, _operation: string, scope: unknown) => {
    observed = scope; return true;
  } });
  f.input.scope.forum = "changed-by-caller";
  a.receive(f.task()); assert.deepEqual(observed, expected); assert.ok(Object.isFrozen(observed));
});
