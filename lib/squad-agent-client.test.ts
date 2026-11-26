import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSquadAgentMcp, openSquadAgentClient } from "./squad-agent-client";
import { openSquadArtifactTools } from "./squad-agent-artifacts";
import { createSeaPair } from "./identity/sea";
import { readForumSignature } from "./forum-sign";

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

test("managed MCP and CLI reuse the admitted operation and current native Squad session", async t => {
  const dir = mkdtempSync(join(tmpdir(), "squad-artifact-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const identityFile = join(dir, "identity.json"), pairFile = join(dir, "key.json");
  const pair = await createSeaPair();
  const origin = "https://squad.fixture.test", forum = "forum_partner_pilot";
  writeFileSync(pairFile, JSON.stringify(pair), { mode: 0o600 });
  const delegationId = "a".repeat(64);
  writeFileSync(identityFile, JSON.stringify({ version: 1, origin, delegationId, pairFile }), { mode: 0o600 });
  const operationId = randomUUID(), planeTask = randomUUID(), taskId = randomUUID();
  const briefRevisionId = randomUUID(), workbookRevisionId = randomUUID(), previewBaseRevisionId = randomUUID();
  const checkpoint = { taskId, briefRevisionId, workbookRevisionId, previewBaseRevisionId };
  const artifact = { kind: "preview", draft: { taskId, artifactId: randomUUID(), revisionId: randomUUID(),
    base: previewBaseRevisionId, briefRevisionId, workbookRevisionId,
    copy: { title: "Partner pilot", summary: "10 seats for 30 days", highlights: [], nextStep: "Review the quote" } } };
  const visorBinary = "/usr/local/bin/hypermesh-visor-headless";
  const calls: Array<{ args: string[]; input: string }> = [];
  let revoked = false;
  let mismatched = false;
  const tools = openSquadArtifactTools({ forum, identityFile, visorBinary }, requested => {
    if (requested !== operationId) throw Error("Operation is not admitted");
    return planeTask;
  }, async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (url === origin + "/api/identity/agent/challenge") {
      assert.deepEqual(body, { delegationId, scopes: ["forum:read"] });
      return revoked ? Response.json({}, { status: 403 }) : Response.json({ challenge: "challenge.one" });
    }
    assert.equal(url, origin + "/api/identity/agent/exchange");
    assert.equal(await readForumSignature(body.signature, pair.pub), body.challenge);
    return Response.json({ token: "token.one", tokenType: "Bearer" });
  }, async (path, args, input) => {
    assert.equal(path, visorBinary);
    calls.push({ args, input });
    if (args[0] === "squad-publish") {
      const { draft } = JSON.parse(input);
      return JSON.stringify({version: 1, taskId, artifactId: draft.artifactId,
        revisionId: mismatched ? randomUUID() : draft.revisionId});
    }
    return JSON.stringify({ taskId });
  });
  const dispatch = createSquadAgentMcp(async () => "Conductor fixture output", tools);
  const request = (method: string, params: object, id?: number) =>
    dispatch(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  await request("initialize", { protocolVersion: "2025-06-18" }, 1);
  await request("notifications/initialized", {});
  const registry = JSON.stringify(await request("tools/list", {}, 2));
  for (const name of ["submit_admitted_operation", "resume_squad_project", "publish_squad_artifact"]) assert.match(registry, new RegExp(name));
  const result = await request("tools/call", { name: "resume_squad_project", arguments: { operationId, checkpoint } }, 3);
  assert.ok(result && "result" in result);
  assert.deepEqual(calls[0], { args: ["squad-resume", origin, forum, planeTask, pair.pub, "0", taskId,
    "--sources", briefRevisionId, workbookRevisionId, "--preview-base", previewBaseRevisionId], input: "token.one\n" });
  await tools.publish(operationId, artifact);
  assert.deepEqual(calls[1], { args: ["squad-resume", origin, forum, planeTask, pair.pub, "0", taskId], input: "token.one\n" });
  assert.deepEqual(calls[2], { args: ["squad-publish", planeTask], input: JSON.stringify(artifact) });
  assert.equal(await tools.publish(operationId, artifact), JSON.stringify({version: 1,
    taskId, artifactId: artifact.draft.artifactId, revisionId: artifact.draft.revisionId}));
  assert.deepEqual(calls[4], calls[2]);
  await assert.rejects(tools.publish(randomUUID(), artifact));
  await assert.rejects(tools.publish(operationId, { ...artifact, draft: { ...artifact.draft, signature: "fixture" } }));
  mismatched = true;
  await assert.rejects(tools.publish(operationId, artifact), /different artifact coordinates/);
  revoked = true;
  await assert.rejects(tools.publish(operationId, artifact));
  assert.equal(calls.length, 7);
});

test("configured MCP keeps a supported large brief in the tool protocol", { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "squad-mcp-frame-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ version: 1, origin: "https://conductor.fixture.test",
    tenant: randomUUID(), bot: randomUUID(), operationsDirectory: dir, credentialFile: join(dir, "credential"),
    squadArtifacts: { forum: "forum_partner_pilot", identityFile: join(dir, "identity"), visorBinary: join(dir, "visor") },
  }), { mode: 0o600 });
  const script = fileURLToPath(new URL("../scripts/s3rch-squad-agent.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", script, config, "mcp"],
    { stdio: ["pipe", "pipe", "ignore"] });
  t.after(() => { child.kill(); });
  const exited = once(child, "close");
  const output = createInterface({ input: child.stdout });
  const draft = { taskId: randomUUID(), artifactId: randomUUID(), revisionId: randomUUID(), base: null,
    markdown: "Partner pilot details. ".repeat(430).trimEnd() };
  const request = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "publish_squad_artifact", arguments: { operationId: randomUUID(), artifact: { kind: "brief", draft } } } });
  assert.ok(Buffer.byteLength(request) > 8192);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18" } }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(request + "\n");
  let reply: { id: number; result?: { isError?: boolean } } | undefined;
  for await (const line of output) {
    const message = JSON.parse(line) as NonNullable<typeof reply>;
    if (message.id === 2) {
      reply = message;
      child.stdin.end();
      break;
    }
  }
  assert.deepEqual(await exited, [0, null]);
  assert.equal(reply?.id, 2);
  assert.equal(reply?.result?.isError, true, "the missing admitted operation is refused at tool dispatch");
});
