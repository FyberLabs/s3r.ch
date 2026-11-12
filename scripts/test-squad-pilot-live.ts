import { signBrowserAssignment } from "../lib/assignment-browser-sign";
import { createHttpForumAuthorityReader } from "../lib/forum-authority-http";
/** Explicit operator acceptance against the configured HTTPS deployment. Reads
 * private operator material locally; never emits cookies, keys or proof bodies. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseSquadPilotConfig } from "../lib/squad-pilot-config";
import { createSquadSessionClient } from "../lib/squad-session-client";
import { createHttpAssignmentClient } from "../lib/assignment-client";
import { signForumRecord } from "../lib/forum-sign";
import type { SeaPair } from "../lib/identity/sea";
import type { DrawerRecord } from "../lib/forum-drawer";

async function main() {
  const [directory, action] = process.argv.slice(2);
  if (!directory || action !== "reassign") throw Error("Usage: test-squad-pilot-live.ts PRIVATE_DIRECTORY reassign");
  const c = parseSquadPilotConfig(readFileSync(resolve(directory, "deployment.json"), "utf8")); assert.ok(c);
  const { identities } = JSON.parse(readFileSync(resolve(directory, "operator.json"), "utf8")) as { identities: SeaPair[] };
  assert.equal(identities[0].pub, c.squad.owner);
  const scope = { forum: c.squad.forumId, owner: c.squad.owner }, base = "/api/squad/pilot";
  async function client(pair: SeaPair) {
    const jar = new Map<string, string>();
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input), c!.origin); assert.equal(url.origin, c!.origin);
      const headers = new Headers(init?.headers); headers.set("origin", c!.origin); headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
      const response = await fetch(url, { ...init, headers, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(15000) });
      for (const cookie of response.headers.getSetCookie()) { const [name, value] = cookie.split(";")[0].split("="); if (value) jar.set(name, value); else jar.delete(name); }
      return response;
    };
    const session = createSquadSessionClient({ squad: c!.squad, origin: c!.origin, base: base + "/session", fetch: transport });
    assert.equal(await session.signIn(pair), true, "SEA challenge/exchange");
    return { transport, session, assignments: createHttpAssignmentClient({ base: base + "/assignment", fetch: transport,
      signPlan: (plan, requested) => signBrowserAssignment({ plan, requested, pair, config: c!.authority,
        read: createHttpForumAuthorityReader({ endpoint: base + "/authority", squad: c!.squad, fetch: transport }), signal: new AbortController().signal, approve: async () => true }) }) };
  }
  const owner = await client(identities[0]), previous = await client(identities[1]);
  const planPath = resolve(directory, "live-assignment.json");
  if (!existsSync(planPath)) {
    const state = await owner.assignments.read(scope); assert.equal(state.assignee, identities[1].pub);
    writeFileSync(planPath, JSON.stringify({ operationId: randomBytes(16).toString("hex"), revision: state.revision }), { flag: "wx", mode: 0o600 });
  }
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      const state = await owner.assignments.read(scope);
      const result = state.operation || state.receipts[plan.operationId]
        ? await owner.assignments.resume(scope, plan.operationId, identities[2].pub)
        : await owner.assignments.start(scope, plan.operationId, identities[2].pub, plan.revision);
      if (result.status === "complete") break;
    } catch { if (Date.now() >= deadline) throw Error("Assignment did not converge"); }
    if (Date.now() >= deadline) throw Error("Assignment deadline");
    await delay(100);
  }
  const replacement = await client(identities[2]);
  assert.equal((await owner.assignments.read(scope)).assignee, identities[2].pub);
  assert.equal((await owner.assignments.resume(scope, plan.operationId, identities[2].pub)).status, "complete");
  await assert.rejects(previous.assignments.readChild(scope, scope.forum));
  assert.equal(await replacement.assignments.readChild(scope, scope.forum), null);
  const at = Math.floor(Date.now() / 1000);
  const response = await owner.transport(base + "/authority", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, forumId: scope.forum, owner: scope.owner, evaluatedAt: at }) });
  assert.equal(response.status, 200);
  const envelope = await response.json();
  const child = envelope.snapshot.rows.find((r: { kind: string; soul: string }) => r.kind === "object" && r.soul.startsWith("update_"))?.soul;
  assert.ok(child, "provisioned update destination");
  const saved = await replacement.assignments.readChild(scope, child);
  const record: DrawerRecord = { domain: "s3rch-forum-child-v1", kind: "update", forumId: scope.forum, agent: scope.owner, id: child,
    writer: identities[2].pub, rev: (saved?.record.rev ?? 0) + 1, issuedAt: Math.floor(Date.now() / 1000), stated: 1,
    body: "Synthetic pilot live assignment acceptance", state: "", target: "" };
  const signature = await signForumRecord(record, identities[2]); assert.ok(signature);
  assert.equal(await replacement.assignments.publishChild(scope, record, signature), true);
  assert.deepEqual((await replacement.assignments.readChild(scope, child))?.record, record);
  const forbidden = { ...record, writer: identities[1].pub, rev: record.rev + 1 };
  assert.equal(await previous.assignments.publishChild(scope, forbidden, (await signForumRecord(forbidden, identities[1]))!), false);
  const reconnected = await client(identities[2]);
  assert.deepEqual((await reconnected.assignments.readChild(scope, child))?.record, record);
  assert.equal(await replacement.session.logout(), true);
  await assert.rejects(replacement.assignments.readChild(scope, child));
  console.log("Live independent-client sessions, durable reassignment/receipt, child write, revoked prior writer, reconnect and logout passed.");
  console.log("This HTTP matrix does not certify browser presentation or provider recovery.");
}
main().catch(() => { console.error("Live pilot acceptance failed; credentials/proofs omitted."); process.exitCode = 1; });
