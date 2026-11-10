import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { buildForumStatement } from "./forum-squad";
import { seaToPrincipalKey } from "./identity/forum-check";
import type { SeaPair } from "./identity/sea";
import { canReadHop, forwardStatement, signedForward } from "./forum-report-forward";
import { readForumSignature, signForumRecord } from "./forum-sign";

test("destination checks and SEA signatures bind both hops to the report revision and exact upstream forward", async () => {
  const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
  const [a,b] = await Promise.all([sea.pair(), sea.pair()]);
  const forum = (index: number) => ({ owner: a.pub, label: "Forum", forumId: `forum_${seaToPrincipalKey(a.pub)}_${String(index).repeat(32)}` });
  const path = { squad: forum(1), fleet: forum(2), command: forum(3) };
  const row = buildForumStatement({ forumId: path.squad.forumId, author: a.pub, now: 100,
    entropy: "e".repeat(32), extras: ["report"], body: "Situation report" })!;
  const objects = [path.squad.forumId, path.fleet.forumId, path.command.forumId, row.id];
  const allowed = new Set(objects);
  const graph = { ownerOf: () => a.pub, checkForumSee: (id: string) => ({ allowed: allowed.has(id), reason: "fixture" }) };
  assert.equal(canReadHop(graph, path, "command", row, b.pub, 100), true);
  for (const id of objects) {
    allowed.delete(id);
    assert.equal(canReadHop(graph, path, "command", row, b.pub, 100), false);
    assert.equal(canReadHop(graph, path, "fleet", row, b.pub, 100), id === path.command.forumId);
    allowed.add(id);
  }
  const fleet = signedForward(forwardStatement(path, "fleet", row, null), a.pub);
  const first = (await signForumRecord(fleet, a))!;
  assert.equal(await readForumSignature(first, a.pub), fleet);
  const command = signedForward(forwardStatement(path, "command", row, first), b.pub);
  const second = (await signForumRecord(command, b))!;
  assert.equal(await readForumSignature(second, b.pub), command);
  assert.notEqual(command, signedForward(forwardStatement(path, "command", row, "different"), b.pub));
  assert.notEqual(command, signedForward(forwardStatement(path, "command", { ...row, body: "updated" }, first), b.pub));
  assert.notEqual(command, signedForward(forwardStatement(path, "command", row, first), a.pub));
  assert.throws(() => forwardStatement(path, "command", row, null));
});
