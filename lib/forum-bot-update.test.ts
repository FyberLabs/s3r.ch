import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForumBotMessage } from "../components/ForumBotMessage";
import { encodeBotMessage, parseBotMessage, type BotMessage } from "./forum-bot-protocol";
import { validateBotUpdateText } from "./forum-bot-update-text";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { createForumBotWorker } from "./forum-bot-worker";
import { openForumBotOutbox } from "./forum-bot-outbox";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("free-text updates round-trip within the statement body limit", () => {
  const tenant = randomUUID(), task = randomUUID();
  const text = "Implemented parser and tests; waiting on review.";
  const message: BotMessage = ["update", tenant, task, text];
  const body = encodeBotMessage(message);
  assert.deepEqual(parseBotMessage(body), message);
  assert.equal(validateBotUpdateText(text, { tenant, task }), text);
});

test("update bodies refuse nested bot commands, grant material and handles", () => {
  const tenant = randomUUID(), task = randomUUID(), handle = randomUUID();
  const bind = { tenant, task, handles: [handle] };
  const reject = (text: string) => assert.throws(() => validateBotUpdateText(text, bind), /Invalid bot update/);
  reject(`visor:v1:${JSON.stringify(["progress", tenant, task, 9])}`);
  reject(`{"version":1,"handle":"${handle}","artifactReaders":[]}`);
  reject(handle);
  reject(`prefix ${handle} suffix`);
  reject('{"steps":[{"tool":"view","arguments":{}}]}');
  reject("-----BEGIN PRIVATE KEY-----");
  reject('{"priv":"abc"}');
  assert.throws(() => validateBotUpdateText("x".repeat(181), bind), /Invalid bot update/);
  assert.throws(() => validateBotUpdateText("  leading space", bind), /Invalid bot update/);
});

test("an enrolled bot posts an update without a local approval file", async t => {
  const f = await forumBotFixture(t), task = f.task(), signed = await f.signed(task), channel = f.open();
  const dir = mkdtempSync(join(tmpdir(), "bot-update-")); chmodSync(dir, 0o700);
  const outbox = openForumBotOutbox(join(dir, "outbox.db"), { tenant: f.tenant, forum: f.forum, bot: f.botB, principal: f.b.pub });
  t.after(() => { outbox.close(); rmSync(dir, { recursive: true, force: true }); });
  const worker = createForumBotWorker({ tenant: f.tenant, channel,
    approvals: { read: () => null },
    artifacts: { put() { throw Error("unused"); }, read: async () => { throw Error("unused"); }, revoke() {} },
    refresh: async () => { await f.refresh(); return true; },
    publish: async message => outbox.enqueue(message),
    executor: { consent: async () => ({ running: false, resume: 0 }), submit: async () => { throw Error("unused"); },
      status: async () => { throw Error("unused"); }, cancel: async () => {} },
  });
  await worker.track([signed]);
  f.setHandles(false);
  assert.equal(channel.claim(task[2]), null);
  assert.equal(channel.authorized(task[2]), false);
  await worker.postUpdate(task[2], "Shipped the contract slice with green unit tests.");
  const queued = outbox.next();
  assert.ok(queued);
  assert.match(queued.body, /^visor:v1:\["update"/);
  assert.ok(parseBotMessage(queued.body)?.[0] === "update");
  assert.ok(!queued.body.includes(task[4]));
});

test("updates are refused when post access is unavailable", async t => {
  const f = await fixtureWithPostRemoval(t);
  const { worker, task, signed } = f;
  await worker.track([signed]);
  await f.stripPost();
  await assert.rejects(worker.postUpdate(task[2], "Should not publish"), /posting unavailable/);
});

test("correlated updates follow progress rules and do not execute tools", async t => {
  const f = await forumBotFixture(t), task = f.task(), channel = f.open();
  await channel.receive([await f.signed(task)]);
  const update = await f.signed(["update", f.tenant, task[2], "Checked in remaining tests"], f.b);
  const admitted = await channel.event(update);
  assert.equal(admitted.message[0], "update");
  assert.equal(channel.status(task[2]), "pending");
  f.setHandles(false);
  assert.throws(() => channel.claim(task[2]), /authority/);
  await assert.rejects(channel.event(await f.signed(["update", f.tenant, task[2], "Foreign"], f.a)));
});

test("paused bots refuse new task updates", async t => {
  const f = await forumBotFixture(t), task = f.task(), signed = await f.signed(task), channel = f.open();
  const worker = createForumBotWorker({ tenant: f.tenant, channel,
    approvals: { read: () => null },
    artifacts: { put() { throw Error("unused"); }, read: async () => { throw Error("unused"); }, revoke() {} },
    refresh: async () => { await f.refresh(); return true; },
    publish: async () => { throw Error("must not publish"); },
    postingPaused: () => true,
    executor: { consent: async () => ({ running: false, resume: 0 }), submit: async () => { throw Error("unused"); },
      status: async () => { throw Error("unused"); }, cancel: async () => {} },
  });
  await worker.track([signed]);
  await assert.rejects(worker.postUpdate(task[2], "Paused bots stop"), /posting unavailable/);
});

test("forum rendering shows the bot update without execution controls", () => {
  const id = randomUUID();
  const html = renderToStaticMarkup(createElement(ForumBotMessage, {
    message: ["update", id, id, "Ready for dogfood on TEST."], author: "bot",
  }));
  assert.match(html, /Task update/);
  assert.match(html, /Ready for dogfood on TEST/);
  assert.match(html, /does not approve tools/);
  assert.doesNotMatch(html, /<button|href=|src=/);
});

async function fixtureWithPostRemoval(t: test.TestContext) {
  const f = await forumBotFixture(t), task = f.task(), signed = await f.signed(task), channel = f.open();
  const dir = mkdtempSync(join(tmpdir(), "bot-update-")); chmodSync(dir, 0o700);
  const outbox = openForumBotOutbox(join(dir, "outbox.db"), { tenant: f.tenant, forum: f.forum, bot: f.botB, principal: f.b.pub });
  t.after(() => { outbox.close(); rmSync(dir, { recursive: true, force: true }); });
  const worker = createForumBotWorker({ tenant: f.tenant, channel,
    approvals: { read: () => null },
    artifacts: { put() { throw Error("unused"); }, read: async () => { throw Error("unused"); }, revoke() {} },
    refresh: async () => { await f.refresh(); return true; },
    publish: async message => outbox.enqueue(message),
    executor: { consent: async () => ({ running: false, resume: 0 }), submit: async () => { throw Error("unused"); },
      status: async () => { throw Error("unused"); }, cancel: async () => {} },
  });
  return { f, worker, task, signed, stripPost: async () => {
    const kept = f.rows.filter(row => !(row.kind === "post" && (row.record as { accessor?: string }).accessor === f.b.pub));
    f.rows.length = 0; f.rows.push(...kept);
    await f.refresh();
  } };
}