import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { createBotStatementAdmission } from "./forum-bot-statement-admission";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { seaToPrincipalKey } from "./identity/forum-check";
import vectors from "./identity/vectors/forum-authority.json";
async function setup(t: test.TestContext) {
  const f = await forumBotFixture(t), origin = "https://forum.example.test";
  let revision = 0, changed = false, expired = false, writes = 0, hung = false;
  const rows = [...f.rows];
  const snapshot = () => ({ completeThrough: f.now(), rows,
    history: { completeThrough: f.now(), links: [], accounts: [f.owner, f.a, f.b].map(pair =>
      ({ principal: pair.pub, rotations: [], revocations: [], genesisEpubBindings: [] })) } });
  const service = createBotStatementAdmission({ origin, squad: { owner: f.owner.pub, forumId: f.forum, label: "Bot admission" },
    config: { keys: [], pinnedIssuers: [], policy: vectors.context.policy }, clock: f.now,
    authenticate: async request => request.headers.get("x-test-key") === "none" ? null : { key: request.headers.get("x-test-key") ?? f.b.pub },
    source: { read: async () => hung ? new Promise<never>(() => {}) : ({ snapshot: snapshot(), fence: String(revision) }),
      append: async (fence, additions, guard) => { if (changed) revision++; if (expired) f.tick(); guard();
        if (fence !== String(revision)) return false;
        rows.push(...additions); revision++; writes++; return true; } } });
  const sign = (kind: AuthorityKind, record: Record<string, unknown>, pair = f.b) => {
    const row = { ...record, sig: "pending" }, parsed = parseForumAuthority(kind, row)!; assert.ok(parsed);
    row.sig = Buffer.from(p256.sign(parsed.bytes, Buffer.from(pair.priv, "base64url"), { prehash: true, format: "compact" })).toString("base64url");
    return { kind, soul: parsed.soul, record: row };
  };
  const object = `stmt_${seaToPrincipalKey(f.b.pub)}_${randomUUID().replaceAll("-", "")}`;
  const additions = [sign("object", { object, owner: f.b.pub, issuedAt: f.now() }),
    sign("see", { object, owner: f.b.pub, accessor: f.owner.pub, from: f.now(), until: f.now() + 60, stated: 1, hamState: 1, issuedAt: f.now() })];
  const request = (extra = {}, key?: string) => new Request(origin + "/api/bot/statement", { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...(key ? { "x-test-key": key } : {}) },
    body: JSON.stringify({ version: 1, forumId: f.forum, owner: f.owner.pub, evaluatedAt: f.now(), rows: additions, ...extra }) });
  return { f, service, additions, request, writes: () => writes, hang(value: boolean) { hung = value; }, change() { changed = true; }, expire() { expired = true; } };
}
test("an independently authenticated bot admits only its signed statement and current reader grants", async t => {
  const s = await setup(t);
  assert.equal((await s.service(s.request({ rows: [] }))).status, 200); assert.equal(s.writes(), 0);
  assert.equal((await s.service(s.request())).status, 200); assert.equal(s.writes(), 1);
});
test("owner impersonation, forged signatures, wrong scope and stale source fences are refused", async t => {
  const s = await setup(t);
  assert.equal((await s.service(s.request({}, "none"))).status, 403);
  assert.equal((await s.service(s.request({}, s.f.owner.pub))).status, 403);
  assert.equal((await s.service(s.request({ forumId: "other-thread" }))).status, 400);
  const forged = structuredClone(s.additions); forged[0].record.sig = "forged";
  assert.notEqual((await s.service(s.request({ rows: forged }))).status, 200);
  s.change(); assert.equal((await s.service(s.request())).status, 409); assert.equal(s.writes(), 0);
});
test("an expired evaluation cannot commit even after signatures verified", async t => {
  const s = await setup(t); s.expire(); assert.equal((await s.service(s.request())).status, 503); assert.equal(s.writes(), 0);
});
test("authenticated slow bodies have per-principal admission limits", async t => {
  const s = await setup(t); const controls: ReadableStreamDefaultController[] = [];
  const slow = () => new Request("https://forum.example.test/api/bot/statement", { method: "POST",
    headers: { Origin: "https://forum.example.test", "Content-Type": "application/json" },
    body: new ReadableStream({ start(controller) { controls.push(controller); } }), duplex: "half" } as RequestInit);
  const first = s.service(slow()), second = s.service(slow());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await s.service(s.request())).status, 429);
  controls.forEach(controller => controller.close()); await Promise.all([first, second]);
  assert.equal((await s.service(s.request({ rows: [] }))).status, 200);
});

test("a stalled primary source releases admission slots and cannot append", async t => {
  const s = await setup(t); s.hang(true);
  const results = await Promise.all([s.service(s.request()), s.service(s.request())]);
  assert.deepEqual(results.map(r => r.status), [503, 503]); assert.equal(s.writes(), 0);
  s.hang(false); assert.equal((await s.service(s.request({ rows: [] }))).status, 200);
});
