import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { openLocalBotApprovals, type LocalBotApproval } from "./forum-bot-local-access";
import { openForumBotArtifacts } from "./forum-bot-artifacts";
import { signForumRecord } from "./forum-sign";

async function setup(t: test.TestContext) {
  const f = await forumBotFixture(t), dir = mkdtempSync(join(tmpdir(), "bot-artifacts-")); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const grants = join(dir, "approvals"), data = join(dir, "artifacts"); mkdirSync(grants, { mode: 0o700 }); mkdirSync(data, { mode: 0o700 });
  const scope = { tenant: f.tenant, forum: f.forum, bot: f.botB, principal: f.b.pub }, handle = randomUUID();
  const grant: LocalBotApproval = { version: 1, ...scope, handle, session: randomUUID(), expires: f.now() + 100, revoked: false,
    task: { steps: [{ tool: "view", arguments: {} }] }, artifactReaders: [f.owner.pub] };
  const path = join(grants, handle + ".json");
  const save = (value: unknown = grant) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); save();
  const approvals = openLocalBotApprovals(grants, scope, f.now);
  const artifacts = openForumBotArtifacts({ directory: data, scope, authority: f.auth.graph, approval: approvals.read, clock: f.now });
  const proof = async (artifact: string, pair = f.owner, fields = {}) => ({ principal: pair.pub, issuedAt: f.now(),
    signature: (await signForumRecord({ version: 1, operation: "read-artifact", tenant: scope.tenant, forum: scope.forum,
      bot: scope.bot, artifact, nonce: randomUUID(), issuedAt: f.now(), ...fields }, pair))! });
  return { f, scope, handle, grant, path, data, save, approvals, artifacts, proof };
}
test("private approvals bind task payload to exact bot scope and current owner decision", async t => {
  const s = await setup(t); assert.ok(s.approvals.read(s.handle));
  assert.equal(s.approvals.read("../escape"), null);
  for (const change of [{ tenant: randomUUID() }, { bot: randomUUID() }, { revoked: true }, { expires: s.f.now() },
    { task: { steps: [{ tool: "shell", arguments: { command: "do not execute" } }] } }]) {
    s.save({ ...s.grant, ...change }); assert.equal(s.approvals.read(s.handle), null);
  }
  s.save(); chmodSync(s.path, 0o644); assert.equal(s.approvals.read(s.handle), null);
  chmodSync(s.path, 0o600); const link = randomUUID(); symlinkSync(s.path, join(s.path, "..", link + ".json"));
  assert.equal(s.approvals.read(link), null);
});
test("artifact bytes require an independent current proof and are never returned by their ID alone", async t => {
  const s = await setup(t), bytes = Buffer.from("private result");
  const id = s.artifacts.put(s.handle, randomUUID(), "application/json", bytes);
  const request = await s.proof(id), result = await s.artifacts.read(request);
  assert.deepEqual(result.bytes, bytes);
  await assert.rejects(s.artifacts.read(request), /already used/);
  await assert.rejects(s.artifacts.read(await s.proof(id, s.f.a)), /denied/);
  await assert.rejects(s.artifacts.read(await s.proof(id, s.f.owner, { tenant: randomUUID() })), /denied/);
  await assert.rejects(s.artifacts.read(await s.proof(id, s.f.owner, { bot: randomUUID() })), /denied/);
  const forged = await s.proof(id); forged.signature += "bad"; await assert.rejects(s.artifacts.read(forged), /denied/);
});
test("revocation, changed reader grants, expired authority and deleted artifacts fail closed", async t => {
  const s = await setup(t), id = s.artifacts.put(s.handle, randomUUID(), "image/png", Buffer.from([1, 2, 3]));
  s.save({ ...s.grant, revoked: true }); await assert.rejects(s.artifacts.read(await s.proof(id)), /denied/);
  s.save({ ...s.grant, artifactReaders: [] }); await assert.rejects(s.artifacts.read(await s.proof(id)), /denied/);
  s.save(); s.f.tick(); await assert.rejects(s.artifacts.read(await s.proof(id)), /denied/);
  await s.f.refresh(); assert.ok(await s.artifacts.read(await s.proof(id)));
  s.save({ ...s.grant, expires: s.f.now() }); await assert.rejects(s.artifacts.read(await s.proof(id)), /denied/);
  s.save(); s.artifacts.revoke(id); await assert.rejects(s.artifacts.read(await s.proof(id)));
});
