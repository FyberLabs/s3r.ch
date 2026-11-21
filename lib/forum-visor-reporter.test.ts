import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { parseVisorForumReport } from "./forum-visor-reporter";

test("Visor reporter only accepts a scoped terminal status projection", async t => {
  const f = await forumBotFixture(t);
  const report = { tenant: f.tenant, botId: f.botA, assignmentId: randomUUID(), sessionId: randomUUID(),
    taskId: randomUUID(), deliveryId: randomUUID(), forumId: f.forum, principal: f.a.pub, status: "completed" };
  assert.deepEqual(parseVisorForumReport(report), report);
  assert.equal(parseVisorForumReport({ ...report, prompt: "private" }), null);
  assert.equal(parseVisorForumReport({ ...report, status: "delivered" }), null);
  assert.equal(parseVisorForumReport({ ...report, deliveryId: "../other" }), null);
});
