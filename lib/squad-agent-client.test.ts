import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSquadAgentMcp, openSquadAgentClient } from "./squad-agent-client";

test("the remote client submits the exact owner bytes without retrying a refusal", async t => {
  const dir = mkdtempSync(join(tmpdir(), "squad-agent-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "config");
  const credentialFile = join(dir, "credential"), token = "hm_rag_" + "b".repeat(64);
  const origin = "https://conductor.fixture.test", tenant = randomUUID(), bot = randomUUID();
  const operation = { version: 1, tenant_id: tenant, bot_id: bot, operation_id: randomUUID(),
    task_id: randomUUID(), assignment_id: randomUUID(), device_id: randomUUID(),
    enrollment_id: randomUUID(), session_id: randomUUID() };
  const raw = JSON.stringify(operation, null, 2) + "\n";
  writeFileSync(config, JSON.stringify({ version: 1, origin, tenant, bot, credentialFile,
    operationsDirectory: dir }), { mode: 0o600 });
  writeFileSync(credentialFile, token, { mode: 0o600 });
  writeFileSync(join(dir, operation.operation_id + ".json"), raw, { mode: 0o600 });
  let calls = 0;
  const client = openSquadAgentClient(config, async (url, init) => {
    assert.equal(String(url), origin + "/v1/remote-agent/prompt-submit");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + token);
    assert.equal(Buffer.from(init?.body as Uint8Array).toString(), raw);
    return ++calls === 1 ? Response.json({ choices: [{ message: { content: "Observed result" } }] })
      : new Response("private failure", { status: 403 });
  });
  await assert.rejects(client.submit("../credential"));
  assert.equal(await client.submit(operation.operation_id), "Observed result");
  await assert.rejects(client.submit(operation.operation_id), /Operation refused/);
  assert.equal(calls, 2);
});

test("MCP only offers the admitted operation tool and cancels an active request", async () => {
  let started = 0;
  const dispatch = createSquadAgentMcp(async (_, signal) => {
    started++;
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(Error("private"))));
  });
  const request = (method: string, params: object, id?: number) =>
    dispatch(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
  const initialized = await request("initialize", { protocolVersion: "2025-06-18" }, 1);
  assert.ok(initialized && "result" in initialized);
  await request("notifications/initialized", {});
  const list = await request("tools/list", {}, 2);
  assert.match(JSON.stringify(list), /submit_admitted_operation/);
  assert.doesNotMatch(JSON.stringify(list), /post_update/);
  const id = randomUUID();
  const refused = await request("tools/call", { name: "submit_admitted_operation",
    arguments: { operationId: id, origin: "https://elsewhere.test" } }, 3);
  assert.ok(refused && "error" in refused);
  const pending = request("tools/call", { name: "submit_admitted_operation", arguments: { operationId: id } }, 4);
  await request("notifications/cancelled", { requestId: 4 });
  const response = await pending;
  assert.equal(started, 1);
  assert.match(JSON.stringify(response), /Operation unavailable/);
  assert.doesNotMatch(JSON.stringify(response), /private/);
});
