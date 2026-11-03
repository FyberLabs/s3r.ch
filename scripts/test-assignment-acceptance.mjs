import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const directory = mkdtempSync(join(tmpdir(), "s3rch-assignment-"));
let server, base, credentials, config;
async function boot() {
  server = spawn(process.execPath, ["--import", "tsx", "scripts/squad-acceptance-server.ts", directory], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let logs = ""; server.stdout.on("data", b => { logs += b; }); server.stderr.on("data", b => { logs += b; });
  const result = await Promise.race([once(server, "message"), once(server, "exit").then(() => { throw Error(logs); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("server readiness timeout: " + logs)), 30000); timer.unref(); })]);
  base = `http://127.0.0.1:${result[0].port}`;
  credentials = JSON.parse(readFileSync(join(directory, "credentials.json"), "utf8")).identities;
  config = await (await fetch(`${base}/config`)).json();
}
async function stop() { if (server && server.exitCode === null) { const done = once(server, "exit"); server.kill("SIGTERM"); await done; } }
async function call(action, actor = 0, body = {}, expected = 200) {
  const response = await fetch(`${base}/api/assignment/${action}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials[actor].token}` }, body: JSON.stringify(body) });
  const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
}
async function finish(id, replacement) {
  for (let i = 0; i < 8; i++) { const result = await call("resume", 0, { operationId: id, replacement }); if (result.status === "complete") return result; }
  throw Error("assignment did not complete");
}
function documents() {
  const db = new DatabaseSync(join(directory, "squad.sqlite"), { readOnly: true });
  const rows = db.prepare("SELECT name,value FROM documents WHERE name LIKE 'cancellations/%' OR name LIKE 'grants/%'").all(); db.close();
  return new Map(rows.map(r => [r.name, r.value]));
}
try {
  await boot();
  assert.equal((await call("access", 1)).canPost, true);
  await call("synthetic-write", 1, { body: "Before reassignment" });
  await call("fault", 0, { kind: "child-ack" });
  await call("synthetic-write", 1, { body: "Committed despite lost response" }, 409);
  const recoveredChild = await call("read-child", 1, { id: config.child });
  assert.equal(recoveredChild.record.body, "Committed despite lost response");
  await call("child", 1, recoveredChild);
  await call("synthetic-write", 1, { body: "Next revision after recovery" });
  await call("read", 1, {}, 403);
  await call("read", 0, { forum: "foreign", owner: config.owner }, 409);
  const id = randomBytes(16).toString("hex"), replacement = credentials[2].pub;
  await call("fault", 0, { kind: "grant-ack" });
  const before = await call("read");
  const started = await call("start", 0, { operationId: id, replacement, revision: before.revision });
  assert.equal(started.status, "pending");
  for (let i = 0; i < 8 && (await call("read")).operation.phase === "cancellations"; i++)
    await call("resume", 0, { operationId: id, replacement });
  assert.equal((await call("read")).operation.phase, "replacement");
  await call("abort", 0, { operationId: id }, 409);
  const retained = documents();
  await stop(); await boot();
  const completed = await finish(id, replacement);
  assert.equal(completed.status, "complete");
  for (const [key, value] of retained) assert.equal(documents().get(key), value);
  assert.equal((await call("access", 1)).canRead, false); assert.equal((await call("access", 1)).canPost, false);
  assert.equal((await call("access", 2)).canRead, true); assert.equal((await call("access", 2)).canPost, true);
  await call("synthetic-write", 1, { body: "Revoked writer" }, 403);
  await call("synthetic-write", 2, { body: "New assignee" });
  assert.deepEqual(await finish(id, replacement), completed);
  const current = await call("read"), childId = randomBytes(16).toString("hex");
  const admitted = await call("register", 0, { id: childId, revision: current.revision });
  const state = await call("read"), left = randomBytes(16).toString("hex"), right = randomBytes(16).toString("hex");
  const attempts = await Promise.all([left, right].map(operationId => fetch(`${base}/api/assignment/start`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials[0].token}` },
    body: JSON.stringify({ operationId, replacement: credentials[3].pub, revision: state.revision }) })));
  assert.equal(attempts.filter(r => r.status === 409).length, 1);
  const winner = (await call("read")).operation;
  await finish(winner.id, winner.replacement);
  assert.equal((await call("access", 2, { destination: admitted.object })).canPost, false);
  assert.equal((await call("access", 3, { destination: admitted.object })).canPost, true);
  const inspect = await call("inspect");
  assert.equal(inspect.state.children[config.child].record.agent, config.owner);
  assert.equal(inspect.state.destinations.includes(config.child), true);
  assert.equal((await call("access", 3)).owner, config.owner);
  // A lost cancellation acknowledgement remains retryable, or can be aborted
  // before any replacement grant without restoring the old permissions.
  const abortedId = randomBytes(16).toString("hex"), abortBefore = await call("read");
  await call("fault", 0, { kind: "cancellation-ack" });
  await call("start", 0, { operationId: abortedId, replacement: credentials[1].pub, revision: abortBefore.revision });
  await call("abort", 0, { operationId: abortedId });
  await call("resume", 0, { operationId: abortedId, replacement: credentials[1].pub }, 409);
  const revoked = (await call("inspect")).state.rows.find(r => r.kind === "post" && r.record.accessor === credentials[3].pub && r.record.stated === 0);
  assert.ok(revoked);
  assert.equal((await call("access", 3, { destination: revoked.record.object })).canPost, false);
  console.log("PASS: isolated synthetic Squad; signed SEA child writes and lost-ack recovery; authenticated independent HTTP clients; lost grant acknowledgement; process restart; exact retry bytes; assignment receipt replay; new-child inventory; concurrent assignment conflict; revoked writes; ownership/path preservation; abort without restoring access.");
} finally { await stop(); if (process.env.KEEP_ASSIGNMENT_TEST_STATE !== "1") rmSync(directory, { recursive: true, force: true }); }
