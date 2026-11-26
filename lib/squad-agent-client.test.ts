import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
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

test("the enrolled adapter discovers and invokes the same scoped artifact operations as the CLI", async t => {
  const dir = mkdtempSync(join(tmpdir(), "squad-visor-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "config"), sessionFile = join(dir, "session");
  const tenant = randomUUID(), bot = randomUUID(), planeTaskId = randomUUID(), operationId = randomUUID();
  const taskId = randomUUID(), artifactId = randomUUID(), revisionId = randomUUID();
  const point = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "jwk" });
  assert.ok(point.x && point.y);
  const agent = point.x + "." + point.y;
  const ownerHex = Buffer.from(point.x, "base64url").toString("hex") + Buffer.from(point.y, "base64url").toString("hex");
  const scope = { agent, forum: "forum_p_" + ownerHex + "_" + "a".repeat(32), siteOrigin: "https://squad.fixture.test",
    visorPath: join(dir, "visor"), runtimeDirectory: dir, sessionFile };
  writeFileSync(config, JSON.stringify({ version: 1, origin: "https://conductor.fixture.test",
    tenant, bot, credentialFile: join(dir, "conductor"), operationsDirectory: dir, artifactTools: scope }), { mode: 0o600 });
  writeFileSync(sessionFile, "fresh.agent.bearer\n", { mode: 0o600 });
  writeFileSync(join(dir, operationId + ".json"), JSON.stringify({ version: 1, tenant_id: tenant,
    bot_id: bot, task_id: planeTaskId, operation_id: operationId, assignment_id: randomUUID(),
    session_id: randomUUID(), device_id: randomUUID(), enrollment_id: randomUUID() }), { mode: 0o600 });
  const context = { taskId, planeTaskId, delegate: agent };
  const sources = { briefRevisionId: randomUUID(), workbookRevisionId: randomUUID(), previewRevisionId: randomUUID() };
  const artifact = { kind: "preview", draft: { taskId, artifactId, revisionId, base: sources.previewRevisionId,
    briefRevisionId: sources.briefRevisionId, workbookRevisionId: sources.workbookRevisionId,
    copy: { title: "Pilot", summary: "10 seats", highlights: [], nextStep: "Confirm" } } };
  let revoked = false;
  const published: unknown[] = [];
  const client = openSquadAgentClient(config, async () => { throw Error("unexpected Conductor call"); },
    async (trusted, args, stdin, signal) => {
      assert.deepEqual(trusted, scope);
      assert.equal(signal.aborted, false);
      if (args[0] === "squad-resume") {
        assert.equal(stdin.toString(), "fresh.agent.bearer\n");
        assert.deepEqual(args.slice(1, 7), [scope.siteOrigin, scope.forum, planeTaskId, agent, "0", taskId]);
        if (revoked) throw Error("private revoked credential");
        if (args.length === 7) return context;
        assert.deepEqual(args.slice(7), ["--sources", sources.briefRevisionId, sources.workbookRevisionId,
          "--preview-base", sources.previewRevisionId]);
        return { context, previewBase: { artifactId, revisionId: sources.previewRevisionId } };
      }
      assert.deepEqual(args, ["squad-publish", planeTaskId]);
      published.push(JSON.parse(stdin.toString()));
      return { version: 1, taskId, artifactId, revisionId };
    });
  const dispatch = createSquadAgentMcp(client.submit, client.artifacts);
  const request = (method: string, params: object, id?: number) =>
    dispatch(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
  await request("initialize", { protocolVersion: "2025-06-18" }, 1);
  await request("notifications/initialized", {});
  const tools = JSON.stringify(await request("tools/list", {}, 2));
  assert.match(tools, /submit_admitted_operation/);
  assert.match(tools, /resume_squad_task/);
  assert.match(tools, /publish_squad_artifact/);
  const resumed = await request("tools/call", { name: "resume_squad_task",
    arguments: { operationId, taskId, sources } }, 3);
  assert.match(JSON.stringify(resumed), new RegExp(sources.previewRevisionId));
  const input = { operationId, artifact };
  const submitted = await request("tools/call", { name: "publish_squad_artifact", arguments: input }, 4);
  assert.match(JSON.stringify(submitted), new RegExp(revisionId));
  assert.deepEqual(await client.artifacts?.publish(input), { version: 1, taskId, artifactId, revisionId });
  assert.deepEqual(published, [artifact, artifact]);
  await assert.rejects(client.artifacts!.publish({ operationId: randomUUID(), artifact }));
  revoked = true;
  const denied = JSON.stringify(await request("tools/call", { name: "publish_squad_artifact", arguments: input }, 5));
  assert.match(denied, /isError/);
  assert.doesNotMatch(denied, /private|bearer/);
  assert.equal(published.length, 2);
});
