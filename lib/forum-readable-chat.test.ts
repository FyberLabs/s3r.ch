import assert from "node:assert/strict";
import test from "node:test";
import { PILOT_CHAT, PILOT_FORUM_ID, PILOT_OWNER } from "./forum-squad-fixture";
import { readableForumChat } from "./forum-readable-chat";

test("live statement visibility requires current reader and author authority on every projection", () => {
  const report = PILOT_CHAT.find(row => row.tags.includes("report"))!;
  const allowed = new Set([PILOT_FORUM_ID, report.id]);
  let reader = "reader", post = true, authorSee = true, proven = true;
  const graph = {
    principalForKey: (key: string) => key === "authenticated" ? reader : null,
    checkForumSee: (object: string, accessor: string) => ({ allowed: accessor === reader && allowed.has(object), reason: "test" }),
    checkDirectSee: (_object: string, accessor: string) => ({ allowed: accessor === report.author && authorSee, reason: "test" }),
    checkPost: (_object: string, accessor: string) => ({ allowed: accessor === report.author && post, reason: "test" }),
  };
  const select = (key: string | null = "authenticated") =>
    readableForumChat([report], PILOT_FORUM_ID, key, graph, () => proven, 100);
  assert.deepEqual(select(), [report]);
  for (const key of [null, "old-key"]) assert.deepEqual(select(key), []);
  for (const object of [report.id, PILOT_FORUM_ID]) {
    allowed.delete(object); assert.deepEqual(select(), []); allowed.add(object);
  }
  post = false; assert.deepEqual(select(), []); post = true;
  authorSee = false; assert.deepEqual(select(), []); authorSee = true;
  proven = false; assert.deepEqual(select(), []); proven = true;
  reader = PILOT_OWNER; assert.deepEqual(select(), []);
});
