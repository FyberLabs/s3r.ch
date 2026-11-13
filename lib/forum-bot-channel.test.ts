import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createForumAuthority, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { seaToPrincipalKey } from "./identity/forum-check";
import vectors from "./identity/vectors/forum-authority.json";
import type { SeaPair } from "./identity/sea";
import { buildForumStatement } from "./forum-squad";
import { signForumRecord } from "./forum-sign";
import { toGunNode } from "./feed-types";
import { encodeBotMessage, parseBotMessage, type BotTaskMessage, type BotMessage } from "./forum-bot-protocol";
import { openForumBotChannel, type SignedBotStatement } from "./forum-bot-channel";
const sea = createRequire(import.meta.url)("gun/sea") as { pair(): Promise<SeaPair> };

async function fixture(t: test.TestContext) {
  const [owner, a, b] = await Promise.all([sea.pair(), sea.pair(), sea.pair()]);
  const tenant = randomUUID(), botA = randomUUID(), botB = randomUUID();
  const forum = `forum_${seaToPrincipalKey(owner.pub)}_${"a".repeat(32)}`;
  let at = 1700000060, consent = true, handles = true;
  const auth = createForumAuthority({ keys: [], pinnedIssuers: [], policy: vectors.context.policy }, () => at);
  const sign = (kind: AuthorityKind, value: object) => {
    const row = { issuedAt: at - 10, ...value, sig: "pending" };
    const parsed = parseForumAuthority(kind, row); assert.ok(parsed);
    row.sig = Buffer.from(p256.sign(parsed.bytes, Buffer.from(owner.priv, "base64url"), { prehash: true, format: "compact" })).toString("base64url");
    return { kind, soul: parsed.soul, record: row };
  };
  const rows: ForumAuthoritySnapshot["rows"][number][] = [sign("object", { object: forum, owner: owner.pub })];
  for (const actor of [a.pub, b.pub]) for (const kind of ["see", "post"] as const)
    rows.push(sign(kind, { owner: owner.pub, object: forum, accessor: actor, stated: 1, hamState: 1, from: at - 20, until: at + 1000 }));
  async function refresh(allowed = rows) {
    const result = await auth.refresh({ completeThrough: at,
      history: { completeThrough: at, links: [], accounts: [owner, a, b].map(pair => ({ principal: pair.pub, rotations: [], revocations: [], genesisEpubBindings: [] })) }, rows: allowed }, at);
    assert.ok(result.ok); assert.equal(result.diagnostics.length, 0);
  }
  await refresh();
  const dir = mkdtempSync(join(tmpdir(), "signed-bot-")); chmodSync(dir, 0o700);
  const clients: ReturnType<typeof openForumBotChannel>[] = [];
  const open = (bot = botB, changes = {}) => {
    const client = openForumBotChannel({ path: join(dir, bot + ".sqlite"),
      scope: { tenant, forum, bot, principal: bot === botA ? a.pub : b.pub }, owner: owner.pub,
      bots: { [botA]: a.pub, [botB]: b.pub }, rootSenders: [owner.pub], maxDelegationDepth: 2,
      authority: auth.graph, handleAllowed: () => handles, localConsent: () => consent, clock: () => at, ...changes });
    clients.push(client); return client;
  };
  t.after(() => { for (const c of clients) try { c.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const task = (bot = botB, parent: string | null = null, depth = 2): BotTaskMessage => ["task", tenant, randomUUID(), bot, randomUUID(), at + 100, parent, depth];
  async function signed(message: BotMessage, pair = owner, overrideForum = forum): Promise<SignedBotStatement> {
    const item = buildForumStatement({ forumId: overrideForum, author: pair.pub, body: encodeBotMessage(message), now: at, entropy: randomUUID().replaceAll("-", "") }); assert.ok(item);
    const signature = await signForumRecord(toGunNode(item), pair); assert.ok(signature);
    return { id: item.id, author: item.author, issuedAt: item.ts, signature };
  }
  return { owner, a, b, botA, botB, tenant, forum, task, signed, open, rows, refresh, auth,
    setConsent(v: boolean) { consent = v; }, setHandles(v: boolean) { handles = v; }, tick() { at++; } };
}

test("one user delegates through two independently granted bots with durable replay refusal", async t => {
  const f = await fixture(t), root = f.task(f.botA), child = f.task(f.botB, root[2]);
  const first = await f.signed(root), second = await f.signed(child, f.a);
  const a = f.open(f.botA), b = f.open();
  assert.equal(await a.receive([first]), "stored"); assert.ok(a.claim(root[2]));
  assert.equal(await b.receive([first, second], { before: null, after: "c1" }), "stored");
  assert.ok(b.claim(child[2])); assert.equal(b.claim(child[2]), null); b.close();
  const recovered = f.open(); assert.equal(recovered.cursor(), "c1");
  assert.equal(await recovered.receive([first, second], { before: null, after: "c1" }), "duplicate");
  assert.equal(recovered.status(child[2]), "unknown"); assert.equal(recovered.claim(child[2]), null);
});
test("forged signatures, wrong transport IDs, tenants, forums and recipients are denied", async t => {
  const f = await fixture(t), c = f.open(), task = f.task(), signed = await f.signed(task);
  for (const changed of [{ ...signed, signature: signed.signature.slice(0, -2) + "xx" }, { ...signed, id: signed.id.slice(0, -1) + (signed.id.endsWith("0") ? "1" : "0") },
      { ...signed, author: f.a.pub }, { ...signed, issuedAt: signed.issuedAt + 1 }]) await assert.rejects(c.receive([changed]));
  const foreign = [...task] as unknown as BotTaskMessage;
  await assert.rejects(c.receive([await f.signed(["task", randomUUID(), foreign[2], foreign[3], foreign[4], foreign[5], foreign[6], foreign[7]])]));
  await assert.rejects(c.receive([await f.signed(task, f.owner, f.forum.slice(0, -1) + "b")]));
  await assert.rejects(c.receive([await f.signed(f.task(f.botA))]));
  assert.equal(c.status(task[2]), null);
});
test("delegation cannot cycle, change parent, extend expiry or reset its depth", async t => {
  const f = await fixture(t), root = f.task(f.botA), first = await f.signed(root), c = f.open();
  const wrongs: BotTaskMessage[] = [f.task(f.botB, randomUUID()), f.task(f.botB, root[2], 4),
    ["task", f.tenant, randomUUID(), f.botB, randomUUID(), root[5] + 1, root[2], 2]];
  for (const child of wrongs) await assert.rejects(c.receive([first, await f.signed(child, f.a)]));
  await assert.rejects(c.receive([await f.signed(f.task(), f.a)])); // A bot cannot mint a new root.
  await assert.rejects(c.receive([first, await f.signed(f.task(f.botB, root[2]), f.owner)]));
  const child = f.task(f.botB, root[2]), second = await f.signed(child, f.a);
  const a = f.open(f.botA);
  await assert.rejects(a.receive([first, second, await f.signed(f.task(f.botA, child[2]), f.b)]));
  const noDelegation = f.open(f.botB, { maxDelegationDepth: 0 });
  await assert.rejects(noDelegation.receive([first, second]));
});
test("current grants, current authority second, handles and consent are checked again at dispatch", async t => {
  const f = await fixture(t), c = f.open(), task = f.task(), signed = await f.signed(task);
  await c.receive([signed]); f.setConsent(false); assert.throws(() => c.claim(task[2]), /authority/);
  f.setConsent(true); f.setHandles(false); assert.throws(() => c.claim(task[2]), /authority/); f.setHandles(true);
  await f.refresh(f.rows.filter(row => !(row.kind === "post" && (row.record as { accessor?: string }).accessor === f.b.pub)));
  assert.throws(() => c.claim(task[2]), /authority/); await f.refresh();
  f.tick(); assert.throws(() => c.claim(task[2]), /authority/); await f.refresh(); assert.ok(c.claim(task[2]));
});
test("the durable task context refuses a rewritten ancestor after restart", async t => {
  const f = await fixture(t), root = f.task(f.botA), child = f.task(f.botB, root[2]), c = f.open();
  const second = await f.signed(child, f.a); await c.receive([await f.signed(root), second]); c.close();
  const reopened = f.open(); assert.throws(() => reopened.claim(child[2]), /authority/);
  await assert.rejects(reopened.receive([await f.signed(root), second]), /Conflicting/);
});
test("bot protocol carries bounded handles and explicit status correlation", () => {
  const tenant = randomUUID(), task = randomUUID();
  for (const message of [["ack", tenant, task], ["cancel", tenant, task], ["progress", tenant, task, 0],
    ["result", tenant, task, "completed", null]] as BotMessage[]) assert.deepEqual(parseBotMessage(encodeBotMessage(message)), message);
  for (const body of ['visor:v2:[]', 'visor:v1:[]', 'visor:v1:' + JSON.stringify(["result", tenant, task, "completed", "https://private/file"]),
    'visor:v1:' + JSON.stringify(["progress", tenant, task, 101])]) assert.equal(parseBotMessage(body), null);
});

test("only the assigned bot reports status and only the issuer cancels pending work", async t => {
  const f = await fixture(t), c = f.open(), task = f.task();
  await c.receive([await f.signed(task)]);
  await assert.rejects(c.event(await f.signed(["ack", f.tenant, task[2]], f.a)));
  const ack = await c.event(await f.signed(["ack", f.tenant, task[2]], f.b));
  assert.equal(ack.message[0], "ack"); assert.equal(c.status(task[2]), "pending");
  await assert.rejects(c.event(await f.signed(["cancel", f.tenant, task[2]], f.b)));
  const cancel = await f.signed(["cancel", f.tenant, task[2]]);
  assert.equal((await c.event(cancel)).cancelled, true);
  assert.equal((await c.event(cancel)).cancelled, false);
  assert.equal(c.status(task[2]), "cancelled"); assert.equal(c.claim(task[2]), null);
});
test("remote results cannot complete local execution and cancellation cannot claim active work stopped", async t => {
  const f = await fixture(t), c = f.open(), task = f.task();
  await c.receive([await f.signed(task)]); assert.ok(c.claim(task[2]));
  await c.event(await f.signed(["result", f.tenant, task[2], "completed", randomUUID()], f.b));
  assert.equal(c.status(task[2]), "claimed");
  assert.equal((await c.event(await f.signed(["cancel", f.tenant, task[2]]))).cancelled, false);
  assert.equal(c.status(task[2]), "claimed");
  await f.refresh(f.rows.filter(row => !(row.kind === "post" && (row.record as { accessor?: string }).accessor === f.b.pub)));
  await assert.rejects(c.event(await f.signed(["progress", f.tenant, task[2], 50], f.b)));
});
