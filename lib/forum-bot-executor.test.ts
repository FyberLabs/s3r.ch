import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, chmodSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalBotExecutor } from "./forum-bot-executor";
import type { LocalBotApproval } from "./forum-bot-local-access";
test("executor only uses explicit loopback leased tasks and never sends start or resume", async t => {
  const dir = mkdtempSync(join(tmpdir(), "bot-executor-")); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, "token"); writeFileSync(tokenFile, "a".repeat(64), { mode: 0o600 });
  for (const origin of ["https://example.test", "http://localhost:9847", "http://127.0.0.1", "http://127.0.0.1:9847/path", "http://user:pass@127.0.0.1:9847"])
    assert.throws(() => createLocalBotExecutor({ origin, tokenFile }));
  const session = randomUUID(), id = randomUUID(), requests: string[] = [];
  let wrongSession = false;
  const executor = createLocalBotExecutor({ origin: "http://127.0.0.1:9847", tokenFile, fetch: async (url, init) => {
    const path = new URL(String(url)).pathname; requests.push(init!.method + " " + path);
    assert.equal(new Headers(init!.headers).get("authorization"), "Bearer " + "a".repeat(64)); assert.equal(init!.redirect, "error");
    if (path === "/companion") return Response.json({ session: { id: session }, automation: { phase: "running", resume_seq: 4 } });
    if (init!.method === "POST") assert.deepEqual(JSON.parse(String(init!.body)), { task: { steps: [{ tool: "view", arguments: {} }] }, authorized_until_ms: 12345, resume_seq: 4 });
    return Response.json({ id, session: wrongSession ? randomUUID() : session, status: "queued", completed_steps: 0, total_steps: 1,
      results: [], cancel_requested: init!.method === "DELETE" });
  } });
  assert.deepEqual(await executor.consent(session), { running: true, resume: 4 });
  const grant: LocalBotApproval = { version: 1, tenant: randomUUID(), forum: "test-thread", bot: randomUUID(),
    principal: "test-principal", handle: randomUUID(), session, expires: 12345, revoked: false, artifactReaders: [],
    task: { steps: [{ tool: "view", arguments: {} }] } };
  assert.deepEqual(await executor.submit(grant, 12345, 4), { id }); await executor.status(session, id); await executor.cancel(session, id);
  assert.deepEqual(requests, ["GET /companion", `POST /session/${session}/tasks/leased`, `GET /session/${session}/tasks/${id}`, `DELETE /session/${session}/tasks/${id}`]);
  wrongSession = true; await assert.rejects(executor.status(session, id), /binding differs/);
  await assert.rejects(executor.status("../escape", id), /scope/);
});
