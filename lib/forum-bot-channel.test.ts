import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { encodeBotMessage, parseBotMessage, type BotTaskMessage, type BotMessage } from "./forum-bot-protocol";
import { forumBotFixture as fixture } from "./forum-bot-test-fixture";

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
    ["result", tenant, task, "completed", null], ["approval", tenant, task, randomUUID(), 10, 20]] as BotMessage[]) assert.deepEqual(parseBotMessage(encodeBotMessage(message)), message);
  for (const body of ['visor:v2:[]', 'visor:v1:[]', 'visor:v1:' + JSON.stringify(["result", tenant, task, "completed", "https://private/file"]),
    'visor:v1:' + JSON.stringify(["approval", tenant, task, randomUUID(), 20, 20]),
    'visor:v1:' + JSON.stringify(["progress", tenant, task, 101])]) assert.equal(parseBotMessage(body), null);
});

test("local approval reports bind the assigned bot and task handle without authorizing execution", async t => {
  const f = await fixture(t), c = f.open(), task = f.task();
  await c.receive([await f.signed(task)]);
  const report: BotMessage = ["approval", f.tenant, task[2], task[4], f.now(), task[5]];
  await assert.rejects(c.event(await f.signed(report, f.a)));
  await assert.rejects(c.event(await f.signed(["approval", f.tenant, task[2], randomUUID(), f.now(), task[5]], f.b)));
  await assert.rejects(c.event(await f.signed(["approval", f.tenant, task[2], task[4], f.now(), task[5] + 1], f.b)));
  assert.equal((await c.event(await f.signed(report, f.b))).message[0], "approval");
  assert.equal(c.status(task[2]), "pending");
  f.setConsent(false); assert.throws(() => c.claim(task[2]), /authority/);
  for (let i = 0; i < 101; i++) f.tick();
  assert.equal((await c.event(await f.signed(report, f.b))).message[0], "approval");
  assert.equal(c.status(task[2]), "pending");
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
  const progress = await f.signed(["progress", f.tenant, task[2], 50], f.b);
  await f.refresh(f.rows.filter(row => !(row.kind === "post" && (row.record as { accessor?: string }).accessor === f.b.pub)));
  await assert.rejects(c.event(progress));
});

test("thread access cannot substitute for statement read authority", async t => {
  const f = await fixture(t), c = f.open(), task = f.task(), signed = await f.signed(task);
  await f.refresh(f.rows.filter(row => !(row.kind === "see" &&
    (row.record as { object?: string; accessor?: string }).object === signed.id &&
    (row.record as { accessor?: string }).accessor === f.b.pub)));
  await assert.rejects(c.receive([signed]), /authority/);
  await f.refresh(); await c.receive([signed]);
  const event = await f.signed(["cancel", f.tenant, task[2]]);
  await f.refresh(f.rows.filter(row => !(row.kind === "see" &&
    (row.record as { object?: string; accessor?: string }).object === event.id &&
    (row.record as { accessor?: string }).accessor === f.b.pub)));
  await assert.rejects(c.event(event), /authority/);
});

test("signed ancestor cancellation blocks current and future descendants across restart", async t => {
  const f = await fixture(t), root = f.task(f.botA), child = f.task(f.botB, root[2]);
  const first = await f.signed(root), second = await f.signed(child, f.a), c = f.open();
  await c.receive([first, second]);
  const result = await c.event(await f.signed(["cancel", f.tenant, root[2]]));
  assert.deepEqual(result.affected, [child[2]]); assert.equal(c.status(child[2]), "cancelled"); c.close();
  const restarted = f.open(), later = await f.signed(f.task(f.botB, root[2]), f.a);
  await assert.rejects(restarted.receive([first, later]), /authority/);
});

test("ancestor cancellation does not depend on a stale retained descendant", async t => {
  const f = await fixture(t), root = f.task(f.botA), old = f.task(f.botB, root[2]), current = f.task(f.botB, root[2]);
  const first = await f.signed(root), stale = await f.signed(old, f.a), live = await f.signed(current, f.a), c = f.open();
  await c.receive([first, stale]); await c.receive([first, live]);
  const cancel = await f.signed(["cancel", f.tenant, root[2]]);
  await f.refresh(f.rows.filter(row => (row.record as { object?: string }).object !== stale.id));
  assert.equal(c.authorized(old[2]), false); assert.equal(c.authorized(current[2]), true);
  const result = await c.event(cancel);
  assert.deepEqual(result.affected, [old[2], current[2]]);
  assert.equal(c.status(old[2]), "cancelled"); assert.equal(c.status(current[2]), "cancelled");
  await f.refresh(); await assert.rejects(c.receive([first, live]), /authority/);
});
