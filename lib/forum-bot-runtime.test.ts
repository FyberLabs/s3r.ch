import assert from "node:assert/strict";
import test from "node:test";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { currentBotReportReaders } from "./forum-bot-runtime";
test("revoking an unrelated bot excludes it from reports without blocking current readers", async t => {
  const f = await forumBotFixture(t), principals = [f.owner.pub, f.a.pub, f.b.pub];
  assert.deepEqual(currentBotReportReaders(f.auth.graph, f.forum, f.b.pub, principals, f.now()), [f.owner.pub, f.a.pub]);
  await f.refresh(f.rows.filter(row => !(row.kind === "see" && (row.record as { accessor?: string }).accessor === f.a.pub)));
  assert.deepEqual(currentBotReportReaders(f.auth.graph, f.forum, f.b.pub, principals, f.now()), [f.owner.pub]);
});
