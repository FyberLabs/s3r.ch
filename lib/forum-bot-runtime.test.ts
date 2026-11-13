import assert from "node:assert/strict";
import test from "node:test";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { currentBotReportReaders, createBotAuthorityRefresh } from "./forum-bot-runtime";
test("revoking an unrelated bot excludes it from reports without blocking current readers", async t => {
  const f = await forumBotFixture(t), principals = [f.owner.pub, f.a.pub, f.b.pub];
  assert.deepEqual(currentBotReportReaders(f.auth.graph, f.forum, f.b.pub, principals, f.now()), [f.owner.pub, f.a.pub]);
  await f.refresh(f.rows.filter(row => !(row.kind === "see" && (row.record as { accessor?: string }).accessor === f.a.pub)));
  assert.deepEqual(currentBotReportReaders(f.auth.graph, f.forum, f.b.pub, principals, f.now()), [f.owner.pub]);
});

test("rejected bot authority never populates the same-second success cache", async t => {
  const f = await forumBotFixture(t);
  const snapshot = { completeThrough: f.now(), rows: f.rows,
    history: { completeThrough: f.now(), links: [], accounts: [f.owner, f.a, f.b].map(pair =>
      ({ principal: pair.pub, rotations: [], revocations: [], genesisEpubBindings: [] })) } };
  let reads = 0, missing = false;
  const input = { authority: f.auth, reader: async () => { reads++; return missing ? null : snapshot; },
    signIn: async () => false, forum: f.forum, owner: f.owner.pub, principal: f.b.pub,
    clock: () => f.now() * 1000 };
  const rejected = createBotAuthorityRefresh({ ...input, key: f.a.pub });
  assert.equal(await rejected(), false);
  assert.equal(f.auth.graph.ownerOf(f.forum), undefined);
  assert.equal(await rejected(), false); assert.equal(reads, 2);
  const accepted = createBotAuthorityRefresh({ ...input, key: f.b.pub });
  assert.equal(await accepted(), true); assert.equal(reads, 3);
  assert.equal(await accepted(), true); assert.equal(reads, 3);
  missing = true;
  assert.equal(await accepted(true), false);
  assert.equal(f.auth.graph.ownerOf(f.forum), undefined);
  assert.equal(await accepted(), false); assert.equal(reads, 5);
});
