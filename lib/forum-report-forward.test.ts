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

test("need escalation binds open source, severity, parent signature and current path access", async () => {
  const { isNeed, sourceRevision, withdrawalStatement } = await import("./forum-report-forward");
  const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };
  const [owner, reader] = await Promise.all([sea.pair(), sea.pair()]);
  const forum = (name: string) => ({ forumId: name, owner: owner.pub, label: name });
  const path = { squad: forum("s"), fleet: forum("f"), command: forum("c") };
  const need = { id: "need", forumId: "s", subject: owner.pub, severity: "emergency" as const,
    stated: 1 as const, body: "Radio down", hamState: 1, ts: 123 };
  const allowed = new Set(["s", "f", "c", need.id]);
  const graph = { ownerOf: () => owner.pub, checkForumSee: (id: string) => ({ allowed: allowed.has(id), reason: "fixture" }) };
  assert.ok(isNeed(need));
  assert.ok(canReadHop(graph, path, "command", need, reader.pub, 1));
  assert.ok(!canReadHop(graph, path, "command", { ...need, severity: "need" }, reader.pub, 1));
  assert.ok(!canReadHop(graph, path, "fleet", { ...need, stated: 0 }, reader.pub, 1));
  for (const id of ["s", "f", "c", need.id]) {
    allowed.delete(id);
    assert.ok(!canReadHop(graph, path, "command", need, reader.pub, 1));
    allowed.add(id);
  }
  allowed.delete("f");
  assert.ok(canReadHop(graph, path, "squad", need, reader.pub, 1));
  const statement = forwardStatement(path, "command", need, "fleet-sig");
  assert.notEqual(statement, forwardStatement(path, "command", need, "replacement"));
  assert.notEqual(statement, forwardStatement(path, "command", { ...need, hamState: 2 }, "fleet-sig"));
  assert.notEqual(sourceRevision(need), sourceRevision({ ...need, body: "New situation" }));
  assert.notEqual(withdrawalStatement(statement, "first"), withdrawalStatement(statement, "second"));
});
