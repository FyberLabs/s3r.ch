import assert from "node:assert/strict";
import test from "node:test";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { createBotStatementAdmission } from "./forum-bot-statement-admission";
import { admitBrowserStatement } from "./forum-statement-browser";
import { createForumAuthority } from "./identity/forum-authority";
import { seaToPrincipalKey } from "./identity/forum-check";
import vectors from "./identity/vectors/forum-authority.json";
async function setup(t: test.TestContext) {
  const f = await forumBotFixture(t), rows = [...f.rows], config = { keys: [], pinnedIssuers: [], policy: vectors.context.policy };
  const squad = { owner: f.owner.pub, forumId: f.forum, label: "Human statements" };
  const snapshot = () => structuredClone({ completeThrough: f.now(), rows, history: { completeThrough: f.now(), links: [],
    accounts: [f.owner, f.a, f.b].map(pair => ({ principal: pair.pub, rotations: [], revocations: [], genesisEpubBindings: [] })) } });
  let revision = 0, calls = 0, posted = "";
  const service = createBotStatementAdmission({ origin: "https://forum.example.test", squad, config, clock: f.now,
    authenticate: async () => ({ key: f.a.pub }), source: { read: async () => ({ snapshot: snapshot(), fence: String(revision) }),
      append: async (fence, additions, guard) => { guard(); if (fence !== String(revision)) return false; rows.push(...additions); revision++; return true; } } });
  const input = { item: { id: `stmt_${seaToPrincipalKey(f.a.pub)}_${"b".repeat(32)}`, author: f.a.pub, ts: f.now() },
    pair: f.a, squad, config, endpoint: "/api/squad/pilot/statement", signal: new AbortController().signal, clock: f.now,
    read: async () => snapshot(), fetch: (async (url, init) => {
      calls++; posted = String(init?.body);
      assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "same-origin");
      assert.ok(!posted.includes(f.a.priv));
      return service(new Request("https://forum.example.test" + url, { ...init, headers: { ...init?.headers, Origin: "https://forum.example.test" } }));
    }) as typeof fetch };
  return { f, input, snapshot, rows, calls: () => calls, posted: () => JSON.parse(posted) };
}
test("browser WebCrypto signatures admit a human statement and only current forum readers; retry is idempotent", async t => {
  const s = await setup(t), result = await admitBrowserStatement(s.input);
  const authority = createForumAuthority(s.input.config, s.f.now);
  assert.equal((await authority.refresh(result.snapshot, result.at)).ok, true);
  for (const pair of [s.f.owner, s.f.a, s.f.b]) assert.equal(authority.graph.checkDirectSee(s.input.item.id, pair.pub, result.at).allowed, true);
  assert.equal(authority.graph.checkPost(s.input.item.id, s.f.a.pub, result.at).allowed, true);
  assert.equal(authority.graph.checkPost(s.input.item.id, s.f.b.pub, result.at).allowed, false);
  const count = s.rows.length; await admitBrowserStatement(s.input); assert.equal(s.rows.length, count);
  assert.equal(s.posted().rows.length, 3); assert.equal(s.calls(), 2);
});
test("invalid scope, identity, key, timestamps and endpoint fail before mutation", async t => {
  const s = await setup(t);
  for (const endpoint of ["//evil.test/statement", "https://evil.test/statement", "/api/x?redirect=1"])
    await assert.rejects(admitBrowserStatement({ ...s.input, endpoint }));
  for (const item of [{ ...s.input.item, id: "bad" }, { ...s.input.item, author: s.f.b.pub },
    { ...s.input.item, ts: s.f.now() + 1 }, { ...s.input.item, ts: s.f.now() - 301 }, { ...s.input.item, ts: -1 }])
    await assert.rejects(admitBrowserStatement({ ...s.input, item }));
  await assert.rejects(admitBrowserStatement({ ...s.input, pair: s.f.b }));
  await assert.rejects(admitBrowserStatement({ ...s.input, squad: { ...s.input.squad, owner: s.f.a.pub } }));
  await assert.rejects(admitBrowserStatement({ ...s.input, read: async () => null }));
  await assert.rejects(admitBrowserStatement({ ...s.input, read: async () => ({ ...s.snapshot(), rows: [] }) }));
  assert.equal(s.calls(), 0);
});
test("HTTP success without committed signed history does not authorize publication", async t => {
  const s = await setup(t);
  await assert.rejects(admitBrowserStatement({ ...s.input, fetch: async () => Response.json({ ok: true }) }), /not confirmed/);
  await assert.rejects(admitBrowserStatement({ ...s.input, fetch: async () => new Response(null, { status: 503 }) }), /unavailable/);
  await assert.rejects(admitBrowserStatement({ ...s.input, fetch: async () => Object.defineProperty(Response.json({}), "redirected", { value: true }) }));
  let reads = 0;
  await assert.rejects(admitBrowserStatement({ ...s.input, read: async () => ++reads === 1 ? s.snapshot() : null }), /not confirmed/);
});
test("cancellation, expiry, lost forum permission and corrupt readback cannot authorize a write", async t => {
  const s = await setup(t), controller = new AbortController(); controller.abort();
  await assert.rejects(admitBrowserStatement({ ...s.input, signal: controller.signal }));
  await assert.rejects(admitBrowserStatement({ ...s.input, read: async () => { s.f.tick(); return s.snapshot(); } }), /expired/);
  let reads = 0;
  await assert.rejects(admitBrowserStatement({ ...s.input, read: async () => {
    const snap = s.snapshot(); if (++reads === 2) snap.rows = []; return snap;
  } }), /not confirmed/);
  const abort = new AbortController();
  await assert.rejects(admitBrowserStatement({ ...s.input, signal: abort.signal, fetch: async () => { abort.abort(); return Response.json({ ok: true }); } }));
});
