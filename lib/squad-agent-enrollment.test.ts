import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentDelegation, type ResolutionContext } from "sociacl-ids";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { signForumRecord } from "./forum-sign";
import { createIdentitySessions } from "./identity/sea-session";
import { readSeaSessionCookie, seaSessionCookieNames } from "./identity/sea-session-http";
import vectors from "./identity/vectors/forum-authority.json";
import { approveSquadAgent, revokeSquadAgent, SQUAD_AGENT_SCOPE, type SquadAgentEnrollment } from "./squad-agent-enrollment";
import { createSquadAgentEnrollmentService } from "./squad-agent-enrollment-service";
import { openSquadAgentIdentity } from "./squad-agent-identity";

test("the signed-in Squad owner grants and revokes native access through the delegated identity contract", async t => {
  const f = await forumBotFixture(t);
  const origin = "https://forum.example.test";
  const rows: { kind: string; record: unknown }[] = [];
  const authority = { keys: [], pinnedIssuers: [], policy: vectors.context.policy };
  const context: Omit<ResolutionContext, "now"> = { jwks: { keys: [] }, links: new Map(), revocations: [],
    pinnedIss: new Set(), policy: { ...authority.policy, clockSkewSeconds: 0 }, history: () => ({ ok: false, reason: "missing-history" }) };
  const used = new Set<string>();
  const sessions = createIdentitySessions({ origin, secret: "squad-enrollment-fixture".repeat(2), clock: f.now,
    consume: async id => { if (used.has(id)) return false; used.add(id); return true; },
    delegationSource: async (id, at) => {
      for (const row of rows) {
        if (row.kind !== "delegation") continue;
        const parsed = parseAgentDelegation(row.record);
        if (parsed.ok && parsed.value.id === id) return { completeThrough: at, delegation: parsed.value.delegation,
          rotations: [], context, revocations: rows.filter(row => row.kind === "revocation").map(row => row.record) };
      }
      return null;
    },
  });
  async function cookie(pair: typeof f.owner) {
    const challenge = await sessions.challenge(pair.pub);
    const signature = await signForumRecord(challenge, pair);
    assert.ok(signature);
    const token = await sessions.exchange(challenge, signature);
    assert.ok(token);
    return seaSessionCookieNames()[0] + "=" + token;
  }
  const ownerCookie = await cookie(f.owner);
  let conflict = false;
  const makeService = (roster: Record<string, string>) => createSquadAgentEnrollmentService({
    pilot: { version: 1, origin, squad: { forumId: f.forum, label: "Partner pilot", owner: f.owner.pub }, authority,
      plane: { origin: "https://plane.example.test", tenant: f.tenant, roster } },
    clock: f.now,
    authenticate: request => sessions.authenticate(readSeaSessionCookie(request) ?? ""),
    read: async at => ({ completeThrough: at, rows: f.rows, history: { completeThrough: at, links: [],
      accounts: [f.owner, f.a, f.b].map(pair => ({ principal: pair.pub, rotations: [], revocations: [], genesisEpubBindings: [] })) } }),
    journal: {
      read: async at => ({ fence: String(rows.length), snapshot: { audience: origin, completeThrough: at,
        history: { completeThrough: at, accounts: [], links: [] }, rows: [...rows] } }),
      async append(fence, saved, guard) {
        guard();
        if (conflict || fence !== String(rows.length)) return false;
        rows.push(...saved as typeof rows);
        return true;
      },
    },
  });
  let service = makeService({ [f.botA]: f.a.pub });
  const call = (body: object, viewer = ownerCookie, site = origin) => service(new Request(origin + "/api/squad/pilot/enrollment", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: site, Cookie: viewer },
    body: JSON.stringify({ forum: f.forum, ...body }),
  }));
  const list = async (): Promise<SquadAgentEnrollment> => {
    const response = await call({ action: "list" });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await call({ action: "list" }, await cookie(f.a))).status, 403);
  assert.equal((await call({ action: "list" }, ownerCookie, "https://unrelated.example")).status, 403);
  assert.equal((await call({ action: "list", forum: f.forum + "x" })).status, 404);
  const start = await list();
  assert.deepEqual(start.agents, [f.a.pub]);
  const unsignedRoute = approveSquadAgent(f.b, start, origin, f.a.pub);
  assert.equal((await call({ action: "approve", record: unsignedRoute })).status, 403);
  const approve = { action: "approve", record: approveSquadAgent(f.owner, start, origin, f.a.pub) };
  conflict = true;
  assert.equal((await call(approve)).status, 409);
  conflict = false;
  const accepted = await call(approve);
  assert.equal(accepted.status, 200);
  const { id } = await accepted.json();
  assert.deepEqual(await (await call(approve)).json(), { id });
  assert.equal(rows.length, 1);
  const directory = mkdtempSync(join(tmpdir(), "squad-agent-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pairFile = join(directory, "pair.json"), config = join(directory, "identity.json");
  writeFileSync(pairFile, JSON.stringify(f.a), { mode: 0o600 });
  writeFileSync(config, JSON.stringify({ version: 1, origin, delegationId: id, pairFile }), { mode: 0o600 });
  const identity = openSquadAgentIdentity(config, async (url, init) => {
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    const payload = JSON.parse(String(init?.body));
    if (String(url) === origin + "/api/identity/agent/challenge") {
      const challenge = await sessions.agentChallenge(payload.delegationId, payload.scopes);
      return challenge ? Response.json({ challenge }) : Response.json({}, { status: 403 });
    }
    assert.equal(String(url), origin + "/api/identity/agent/exchange");
    const token = await sessions.exchangeAgent(payload.challenge, payload.signature);
    return token ? Response.json({ token, tokenType: "Bearer" }) : Response.json({}, { status: 403 });
  });
  const token = await identity.session();
  assert.equal((await sessions.authenticateAgent(token, [SQUAD_AGENT_SCOPE]))?.agent, f.a.pub);
  f.tick();
  service = makeService({});
  const removed = await list();
  assert.deepEqual(removed.agents, []);
  assert.equal(removed.grants[0].id, id);
  const revoke = { action: "revoke", record: revokeSquadAgent(f.owner, removed, id) };
  assert.equal((await call(revoke)).status, 200);
  assert.deepEqual(await (await call(revoke)).json(), { id });
  assert.equal((await list()).grants[0].status, "revoked");
  assert.equal(rows.length, 2);
  assert.equal(await sessions.authenticateAgent(token, [SQUAD_AGENT_SCOPE]), null);
  await assert.rejects(identity.session());
});
