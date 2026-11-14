import { p256 } from "@noble/curves/nist.js";
import { parseForumAuthority } from "./identity/forum-authority-records";
import assert from "node:assert/strict";
import test from "node:test";
import { forumBotFixture } from "./forum-bot-test-fixture";
import { createBotStatementAdmission } from "./forum-bot-statement-admission";
import { admitBrowserRoom } from "./room-authority-browser";
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
    objectKind: "room", authenticate: async () => ({ key: f.a.pub }), source: { read: async () => ({ snapshot: snapshot(), fence: String(revision) }),
      append: async (fence, additions, guard) => { guard(); if (fence !== String(revision)) return false; rows.push(...additions); revision++; return true; } } });
  const input = { share: true, item: { id: `room_${seaToPrincipalKey(f.a.pub)}_${"b".repeat(32)}`, author: f.a.pub, ts: f.now() },
    pair: f.a, squad, config, endpoint: "/api/squad/pilot/room", signal: new AbortController().signal, clock: f.now,
    read: async () => snapshot(), fetch: (async function (this: unknown, url, init) {
      assert.equal(this, undefined);
      calls++; posted = String(init?.body);
      assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "same-origin");
      assert.ok(!posted.includes(f.a.priv));
      return service(new Request("https://forum.example.test" + url, { ...init, headers: { ...init?.headers, Origin: "https://forum.example.test" } }));
    }) as typeof fetch };
  return { f, input, snapshot, rows, calls: () => calls, posted: () => JSON.parse(posted) };
}
test("browser WebCrypto signatures admit a room and current parent see/post grants; exact-second retry is idempotent", async t => {
  const s = await setup(t), result = await admitBrowserRoom(s.input);
  const authority = createForumAuthority(s.input.config, s.f.now);
  assert.equal((await authority.refresh(result.snapshot, result.at)).ok, true);
  for (const pair of [s.f.owner, s.f.a, s.f.b]) assert.equal(authority.graph.checkDirectSee(s.input.item.id, pair.pub, result.at).allowed, true);
  assert.equal(authority.graph.checkPost(s.input.item.id, s.f.a.pub, result.at).allowed, true);
  assert.equal(authority.graph.checkPost(s.input.item.id, s.f.b.pub, result.at).allowed, true);
  const count = s.rows.length; await admitBrowserRoom(s.input); assert.equal(s.rows.length, count);
  assert.equal(s.posted().rows.length, 5); assert.equal(s.calls(), 2);
});
test("invalid scope, identity, key, timestamps and endpoint fail before mutation", async t => {
  const s = await setup(t);
  for (const endpoint of ["//evil.test/statement", "https://evil.test/statement", "/api/x?redirect=1"])
    await assert.rejects(admitBrowserRoom({ ...s.input, endpoint }));
  for (const item of [{ ...s.input.item, id: "bad" }, { ...s.input.item, author: s.f.b.pub },
    { ...s.input.item, ts: s.f.now() + 1 }, { ...s.input.item, ts: -1 }])
    await assert.rejects(admitBrowserRoom({ ...s.input, item }));
  await assert.rejects(admitBrowserRoom({ ...s.input, pair: s.f.b }));
  await assert.rejects(admitBrowserRoom({ ...s.input, squad: { ...s.input.squad, owner: s.f.a.pub } }));
  await assert.rejects(admitBrowserRoom({ ...s.input, read: async () => null }));
  await assert.rejects(admitBrowserRoom({ ...s.input, read: async () => ({ ...s.snapshot(), rows: [] }) }));
  assert.equal(s.calls(), 0);
});
test("HTTP success without committed signed history does not authorize publication", async t => {
  const s = await setup(t);
  await assert.rejects(admitBrowserRoom({ ...s.input, fetch: async () => Response.json({ ok: true }) }), /not confirmed/);
  await assert.rejects(admitBrowserRoom({ ...s.input, fetch: async () => new Response(null, { status: 503 }) }), /unavailable/);
  await assert.rejects(admitBrowserRoom({ ...s.input, fetch: async () => Object.defineProperty(Response.json({}), "redirected", { value: true }) }));
  let reads = 0;
  await assert.rejects(admitBrowserRoom({ ...s.input, read: async () => ++reads === 1 ? s.snapshot() : null }), /not confirmed/);
});
test("cancellation, expiry, lost forum permission and corrupt readback cannot authorize a write", async t => {
  const s = await setup(t), controller = new AbortController(); controller.abort();
  await assert.rejects(admitBrowserRoom({ ...s.input, signal: controller.signal }));
  await assert.rejects(admitBrowserRoom({ ...s.input, read: async () => { s.f.tick(); return s.snapshot(); } }), /expired/);
  let reads = 0;
  await assert.rejects(admitBrowserRoom({ ...s.input, read: async () => {
    const snap = s.snapshot(); if (++reads === 2) snap.rows = []; return snap;
  } }), /not confirmed/);
  const abort = new AbortController();
  await assert.rejects(admitBrowserRoom({ ...s.input, signal: abort.signal, fetch: async () => { abort.abort(); return Response.json({ ok: true }); } }));
});

test("a Mine room admits ownership only and parent revocation dominates child grants", async t => {
  const s = await setup(t);
  const mine = await admitBrowserRoom({ ...s.input, share: false });
  assert.equal(s.posted().rows.length, 1);
  const authority = createForumAuthority(s.input.config, s.f.now);
  await authority.refresh(mine.snapshot, mine.at);
  assert.equal(authority.graph.checkForumSee(s.input.item.id, s.f.b.pub, mine.at).allowed, false);
  const shared = await admitBrowserRoom(s.input);
  await authority.refresh(shared.snapshot, shared.at);
  const { createRoomChatAdmission } = await import("./room-chat-admission");
  const admission = createRoomChatAdmission({ graph: authority.graph, parent: s.f.forum, readerKey: () => s.f.b.pub, clock: s.f.now });
  const message = await admission.compose(s.input.item.id, "hello", () => s.f.a); assert.ok(message);
  assert.equal(admission.readable([message], s.input.item.id).length, 1);
  const cancellation = { object: s.f.forum, owner: s.f.owner.pub, accessor: s.f.b.pub,
    stated: 0, from: s.f.now() - 20, until: s.f.now() + 1000, hamState: 2, issuedAt: s.f.now(), sig: "pending" };
  const parsed = parseForumAuthority("see", cancellation)!;
  cancellation.sig = Buffer.from(p256.sign(parsed.bytes, Buffer.from(s.f.owner.priv, "base64url"), { prehash: true, format: "compact" })).toString("base64url");
  const noParent = { ...shared.snapshot, rows: [...shared.snapshot.rows, { kind: "see" as const, soul: parsed.soul, record: cancellation }] };
  assert.equal((await authority.refresh(noParent, shared.at)).ok, true);
  assert.deepEqual(admission.readable([message], s.input.item.id), []);
});
