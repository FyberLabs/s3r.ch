import { parseAssignmentSignedMaterial, verifyAssignmentSignedMaterial } from "./assignment-signed-material";
import { assignmentCancellationIntents, assignmentReplacementIntents } from "./assignment-signing-plan";
import assert from "node:assert/strict";
import { test } from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createAssignmentJournal, MAX_ASSIGNMENT_DESTINATIONS } from "./delegation-journal";
import { createDelegationRuntime } from "./delegation-runtime";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { createForumAuthority } from "./identity/forum-authority";
import { seaToPrincipalKey } from "./identity/forum-check";
import type { InventoryStore } from "./delegation-inventory";
const secret = (n: number) => { const b = new Uint8Array(32); b[31] = n; return b; };
const pub = (n: number) => { const k = p256.getPublicKey(secret(n), false); return Buffer.from(k.slice(1, 33)).toString("base64url") + "." + Buffer.from(k.slice(33)).toString("base64url"); };
const owner = pub(1), old = pub(2), replacement = pub(3), other = pub(4), at = 1700000060;
const forum = `forum_${seaToPrincipalKey(owner)}_${"1".repeat(32)}`, destination = `need_${seaToPrincipalKey(owner)}_${"2".repeat(32)}`;
const id = "a".repeat(32), config = { keys: [], policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIssuers: [] };
function sign(kind: AuthorityKind, fields: Record<string, unknown>) {
  const record = { ...fields, sig: "pending" }, parsed = parseForumAuthority(kind, record)!;
  record.sig = Buffer.from(p256.sign(parsed.bytes, secret([owner, old, replacement, other].indexOf(parsed.signer) + 1), { prehash: true, format: "compact" })).toString("base64url");
  return { kind, soul: parsed.soul, record };
}
function cas() {
  let value: { text: string; etag: string } | null = null, rev = 0;
  return { async read() { return value; }, async compareAndSwap(etag: string | null, text: string) {
    if ((value?.etag ?? null) !== etag) return false; value = { text, etag: String(++rev) }; return true;
  } } satisfies InventoryStore;
}
async function setup() {
  let signed = 0, writes = 0, failAt = -1, dropAck = false, clockAt = at;
  const base = cas();
  const backing = { ...base, async compareAndSwap(etag: string | null, text: string) {
    writes++; if (writes === failAt && !dropAck) throw Error("offline");
    const result = await base.compareAndSwap(etag, text);
    if (writes === failAt && dropAck) throw Error("response lost"); return result;
  } };
  const journal = createAssignmentJournal(backing, () => clockAt);
  await journal.initialize({ forum, owner, assignee: old, destinations: [destination], rows: [
    ...[forum, destination].map(object => sign("object", { owner, object, issuedAt: at - 100 })),
    ...(["post", "see"] as const).map(kind => sign(kind, { owner, object: destination, accessor: old, stated: 1, hamState: 1, from: at - 100, until: at + 1000, issuedAt: at - 100 })),
  ] });
  const stores = new Map<string, { inventory: InventoryStore; cancellations: ReturnType<typeof outbox>; grants: ReturnType<typeof outbox> }>();
  function outbox() { const documents = new Map<string, string>(); return { documents, async read(id: string) { return documents.get(id) ?? null; }, async create(id: string, value: string) { if (!documents.has(id)) documents.set(id, value); } }; }
  const history = async (time: number) => ({ completeThrough: time, links: [], accounts: [owner, old, replacement, other].map(principal => ({ principal, rotations: [], revocations: [], genesisEpubBindings: [] })) });
  const dependencies = { journal, config, clock: () => clockAt, history,
    operationStores(id: string) { let s = stores.get(id); if (!s) { s = { inventory: cas(), cancellations: outbox(), grants: outbox() }; stores.set(id, s); } return s; },
    async sign(kind: AuthorityKind, fields: Record<string, unknown>) { signed++; return sign(kind, fields); },
  };
  const runtime = createDelegationRuntime(dependencies);
  return { journal, runtime, dependencies, stores, backing: base, get signed() { return signed; },
    tick(seconds: number) { clockAt += seconds; },
    failAfter(n: number, ack = false) { failAt = writes + n; dropAck = ack; },
    async graph() { const a = createForumAuthority(config, () => at); const r = await a.refresh({ completeThrough: at, history: await history(at), rows: (await journal.load()).rows }, at); assert.ok(r.ok); return a.graph; } };
}
async function finish(h: Awaited<ReturnType<typeof setup>>, op = id, target = replacement) {
  for (let n = 0; n < 5; n++) { const r = await h.runtime.resume(owner, op, target); if (r.status === "complete") return r; }
  throw Error("did not recover");
}
test("runtime publishes signed revocations and fresh grants before atomic assignment completion", async () => {
  const h = await setup(), result = await h.runtime.start(owner, id, replacement, 0);
  assert.equal(result.status, "complete", JSON.stringify(result));
  const state = await h.journal.load(), graph = await h.graph();
  assert.equal(state.assignee, replacement); assert.equal(graph.ownerOf(destination), owner);
  assert.equal(graph.checkPost(destination, old, at).allowed, false); assert.equal(graph.checkDirectSee(destination, old, at).allowed, false);
  assert.equal(graph.checkPost(destination, replacement, at).allowed, true); assert.equal(graph.checkDirectSee(destination, replacement, at).allowed, true);
  assert.equal(h.signed, 4);
  const restart = createDelegationRuntime(h.dependencies);
  assert.deepEqual(await restart.resume(owner, id, replacement), result);
  assert.equal(h.signed, 4); assert.equal((await h.journal.load()).revision, state.revision);
});
for (const ack of [false, true]) for (const write of [3, 4, 5, 6, 7, 8, 9]) test(`recovers publication failure at write ${write}, lost ack ${ack}`, async () => {
  const h = await setup(); h.failAfter(write, ack);
  try { await h.runtime.start(owner, id, replacement, 0); } catch { /* durable claim/preparation can lose its response */ }
  const before = h.stores.get(id)?.cancellations.documents.get(id);
  const done = await finish(h); assert.equal(done.status, "complete");
  if (before) assert.equal(h.stores.get(id)!.cancellations.documents.get(id), before);
  assert.equal((await h.graph()).checkPost(destination, old, at).allowed, false);
  assert.equal(h.signed, 4);
});
test("competing clients cannot choose different assignees for one generation", async () => {
  const h = await setup(), second = createDelegationRuntime(h.dependencies);
  const results = await Promise.allSettled([h.runtime.start(owner, id, replacement, 0), second.start(owner, "b".repeat(32), other, 0)]);
  assert.ok(results.some(r => r.status === "rejected"));
  const s = await h.journal.load(); assert.ok(s.operation);
  await finish(h, s.operation.id, s.operation.replacement);
  assert.equal((await h.journal.load()).assignee, s.operation.replacement);
});
test("stale child registration cannot cross an assignment claim", async () => {
  const h = await setup(); await h.journal.claim(owner, id, replacement, 0);
  const child = destination.replace(/2{32}$/, "3".repeat(32));
  await assert.rejects(h.runtime.admit(owner, 0, child, [sign("object", { owner, object: child, issuedAt: at })]), /pending/);
  assert.deepEqual((await h.journal.load()).destinations, [destination]);
});
test("abort before replacement keeps revocations and fences every stale retry", async () => {
  const h = await setup(); h.failAfter(5);
  const result = await h.runtime.start(owner, id, replacement, 0); assert.equal(result.status, "pending");
  await h.runtime.abort(owner, id);
  await assert.rejects(h.runtime.resume(owner, id, replacement), /stale/);
  const s = await h.journal.load();
  assert.equal(s.assignee, old); assert.equal((await h.graph()).checkPost(destination, old, at).allowed, false);
  await h.runtime.start(owner, "b".repeat(32), other, s.revision);
  await assert.rejects(h.runtime.start(owner, id, replacement, (await h.journal.load()).revision), /retired/);
});
test("abort refuses a partially published replacement; retry finishes without restoring old access", async () => {
  const h = await setup(); h.failAfter(8);
  const r = await h.runtime.start(owner, id, replacement, 0); assert.equal(r.status, "pending");
  await assert.rejects(h.runtime.abort(owner, id), /replacement started/);
  await finish(h); assert.equal((await h.graph()).checkPost(destination, old, at).allowed, false);
});
test("lost prepared storage fails closed instead of issuing new signatures", async () => {
  const h = await setup(); h.failAfter(8); await h.runtime.start(owner, id, replacement, 0);
  const signed = h.signed; h.stores.get(id)!.grants.documents.clear();
  const result = await h.runtime.resume(owner, id, replacement);
  assert.equal(result.status, "pending"); assert.equal(h.signed, signed);
  h.stores.get(id)!.cancellations.documents.clear();
  await assert.rejects(h.runtime.resume(owner, id, replacement), /missing prepared/); assert.equal(h.signed, signed);
});
test("owner authentication is mandatory and a second assignment preserves paths", async () => {
  const h = await setup(); await assert.rejects(h.runtime.start(old, id, replacement, 0), /owner/);
  await h.runtime.start(owner, id, replacement, 0);
  const before = await h.journal.load();
  const result = await h.runtime.start(owner, "b".repeat(32), other, before.revision);
  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.deepEqual((await h.journal.load()).destinations, before.destinations);
  const graph = await h.graph(); assert.equal(graph.ownerOf(destination), owner);
  assert.equal(graph.checkPost(destination, replacement, at).allowed, false); assert.equal(graph.checkPost(destination, other, at).allowed, true);
});

test("runtime cancels old group membership alongside direct grants", async () => {
  const h = await setup(), set = `set_${seaToPrincipalKey(owner)}_${"4".repeat(32)}`;
  const rows = [
    sign("membership", { role: "member", predicate: "same-group", set, member: old, setOwner: owner, stated: 1, hamState: 1, cancels: [], issuedAt: at }),
    sign("membership", { role: "set", predicate: "same-group", set, member: old, setOwner: owner, stated: 1, hamState: 1, cancels: [], issuedAt: at }),
    sign("object-set", { owner, object: destination, predicate: "same-group", set, stated: 1, hamState: 1, cancels: [], issuedAt: at }),
  ];
  await h.runtime.admit(owner, 0, destination, rows);
  const r = await h.runtime.start(owner, id, replacement, (await h.journal.load()).revision);
  assert.equal(r.status, "complete", JSON.stringify(r));
  assert.equal((await h.graph()).checkForumSee(destination, old, at).allowed, false);
  assert.ok((await h.journal.load()).rows.some(r => r.kind === "cancel"));
});

for (const corrupt of [
  (s: any) => { delete s.operation; },
  (s: any) => { s.operation = false; },
  (s: any) => { s.usedOperations = []; },
  (s: any) => { s.operation.phase = "complete"; },
  (s: any) => { s.assignee = replacement; },
  (s: any) => { s.operation.phase = "replacement"; },
]) test("corrupt durable operation state fails closed", async () => {
  const h = await setup(); await h.journal.claim(owner, id, replacement, 0);
  const held = (await h.backing.read())!, state = JSON.parse(held.text); corrupt(state);
  await h.backing.compareAndSwap(held.etag, JSON.stringify(state));
  await assert.rejects(h.runtime.resume(owner, id, replacement));
  assert.equal(h.signed, 0);
});
test("a session opened before abort cannot publish or commit afterward", async () => {
  const h = await setup(); await h.journal.claim(owner, id, replacement, 0);
  await h.journal.mutation(owner).run(id, replacement, async session => {
    await session.assertActive(); await h.runtime.abort(owner, id);
    await assert.rejects(session.assertActive(), /aborted/);
    await assert.rejects(session.commit({ operationId: id, replacement, fence: "stale", evaluatedAt: at }), /aborted/);
  });
  assert.equal((await h.journal.load()).assignee, old);
});

test("destination admission cannot smuggle a second unregistered authority destination", async () => {
  const h = await setup(), hidden = destination.replace(/2{32}$/, "5".repeat(32));
  await assert.rejects(h.runtime.admit(owner, 0, destination, [sign("object", { owner, object: hidden, issuedAt: at })]), /missing from inventory/);
  assert.equal((await h.journal.load()).revision, 0);
});

test("committed receipt replays after expiry, registration, and a later assignment", async () => {
  const h = await setup(), completed = await h.runtime.start(owner, id, replacement, 0);
  assert.equal(completed.status, "complete");
  h.tick(86401);
  assert.deepEqual(await h.runtime.resume(owner, id, replacement), completed);
  const child = destination.replace(/2{32}$/, "7".repeat(32));
  await h.runtime.admit(owner, (await h.journal.load()).revision, child, [sign("object", { owner, object: child, issuedAt: at })]);
  assert.deepEqual(await h.runtime.resume(owner, id, replacement), completed);
  await h.journal.claim(owner, "b".repeat(32), other, (await h.journal.load()).revision);
  assert.deepEqual(await h.runtime.resume(owner, id, replacement), completed);
  assert.deepEqual(await h.runtime.start(owner, id, replacement, 0), completed);
  await assert.rejects(h.runtime.resume(owner, id, other), /receipt replacement/);
  await assert.rejects(h.runtime.resume(other, id, replacement), /owner/);
});
test("immutable owner cannot be selected as replacement", async () => {
  const h = await setup();
  await assert.rejects(h.runtime.start(owner, id, owner, 0), /conflict/);
  assert.equal((await h.journal.load()).operation, null);
});
test("journal refuses destinations beyond the planner's bounded cancellation capacity", async () => {
  const h = await setup(), initial = await h.journal.load();
  const destinations = Array.from({ length: MAX_ASSIGNMENT_DESTINATIONS }, (_, i) =>
    `need_${seaToPrincipalKey(owner)}_${(i + 1).toString(16).padStart(32, "0")}`);
  const journal = createAssignmentJournal(cas());
  await journal.initialize({ forum, owner, assignee: old, destinations, rows: [] });
  await assert.rejects(journal.admit(owner, 0, destination, []), /journal/);
  assert.equal((await journal.load()).destinations.length, MAX_ASSIGNMENT_DESTINATIONS);
  assert.ok(MAX_ASSIGNMENT_DESTINATIONS * 3 <= 256);
  assert.equal(initial.assignee, old);
});
for (const mode of ["disabled", "superseded"] as const) test(`historical external group ${mode} does not block reassignment`, async () => {
  const h = await setup(), set = `set_${seaToPrincipalKey(other)}_${"8".repeat(32)}`;
  const external = [
    sign("membership", { role: "member", predicate: "same-group", set, member: old, setOwner: other, stated: 1, hamState: 1, cancels: [], issuedAt: at }),
    sign("membership", { role: "set", predicate: "same-group", set, member: old, setOwner: other, stated: 1, hamState: 1, cancels: [], issuedAt: at }),
    sign("object-set", { owner, object: destination, predicate: "same-group", set, stated: 1, hamState: 1, cancels: [], issuedAt: at }),
    sign("object-set", { owner, object: destination, predicate: "same-group", set: mode === "disabled" ? set : `set_${seaToPrincipalKey(owner)}_${"9".repeat(32)}`,
      stated: mode === "disabled" ? 0 : 1, hamState: 2, cancels: [], issuedAt: at }),
  ];
  await h.runtime.admit(owner, 0, destination, external);
  assert.equal((await h.runtime.start(owner, id, replacement, (await h.journal.load()).revision)).status, "complete");
});

test("claim reserves publication row capacity before freezing ordinary writes", async () => {
  const h = await setup(), held = (await h.backing.read())!, state = JSON.parse(held.text);
  state.rows = Array.from({ length: 1020 }, () => state.rows[0]);
  await h.backing.compareAndSwap(held.etag, JSON.stringify(state));
  await assert.rejects(h.journal.claim(owner, id, replacement, 0), /capacity/);
  assert.equal((await h.journal.load()).operation, null);
});


test("owner signing plan is read-only, deterministic and bound to the current journal", async () => {
  const h=await setup(), before=await h.journal.load();
  const plan=await h.runtime.plan(owner,id,replacement,before.revision);
  assert.equal(plan.owner,owner);assert.equal(plan.previous,old);assert.equal(plan.replacement,replacement);
  assert.equal(plan.revision,0);assert.equal(plan.issuedAt,at);assert.equal(plan.operationId,id);
  assert.equal(plan.cancellations.length,2);assert.equal(plan.grants.length,2);
  for(const intent of [...plan.cancellations,...plan.grants]) {
    const parsed=parseForumAuthority(intent.kind,{...intent.fields,sig:"pending"});
    assert.ok(parsed);assert.equal(parsed.soul,intent.soul);assert.equal(parsed.signer,owner);
    assert.ok(Object.isFrozen(intent.fields));assert.equal("sig" in intent.fields,false);
  }
  assert.deepEqual(await h.runtime.plan(owner,id,replacement,0),plan);
  assert.deepEqual(await h.journal.load(),before);assert.equal(h.signed,0);assert.equal(h.stores.size,0);
  await assert.rejects(h.runtime.plan(other,id,replacement,0));
  await assert.rejects(h.runtime.plan(owner,id,replacement,1));
  await assert.rejects(h.runtime.plan(owner,id,owner,0));
  await assert.rejects(h.runtime.plan(owner,id,old,0));
  await assert.rejects(h.runtime.plan(owner,"bad",replacement,0));
  await h.journal.claim(owner,id,replacement,0);
  await assert.rejects(h.runtime.plan(owner,"b".repeat(32),other,1));
});

for (const race of ["clock", "journal"] as const) test(`signing plan rejects ${race} changes during authority refresh without signing`, async () => {
  const h = await setup(); let calls = 0;
  const runtime = createDelegationRuntime({ ...h.dependencies, async history(time) {
    const history = await h.dependencies.history(time);
    if (++calls === 2) {
      if (race === "clock") h.tick(1);
      else await h.journal.claim(owner, "b".repeat(32), other, 0);
    }
    return history;
  } });
  await assert.rejects(runtime.plan(owner, id, replacement, 0), /plan (authority expired|changed)/);
  assert.equal(h.signed, 0); assert.equal(h.stores.size, 0);
});

test("intent constructors reject invalid operations, times and exhausted revisions", async () => {
  const h = await setup(), loaded = await h.journal.load(), state = { ...loaded, rows: [...loaded.rows] }, graph = await h.graph();
  await assert.rejects(assignmentCancellationIntents(state, "bad", old, at, graph), /operation/);
  for (const time of [-1, 1.5, Number.MAX_SAFE_INTEGER])
    assert.throws(() => assignmentReplacementIntents(state, replacement, time), /range/);
  assert.throws(() => assignmentReplacementIntents(state, "invalid", at), /intent/);
  state.rows.push(sign("post", { owner, object: destination, accessor: replacement, stated: 1,
    hamState: Number.MAX_SAFE_INTEGER, issuedAt: at, from: at, until: at + 1000 }));
  assert.throws(() => assignmentReplacementIntents(state, replacement, at), /range/);
});
test("membership intents deduplicate shared groups and snapshot sorted predecessor IDs", async () => {
  const h = await setup(), loaded = await h.journal.load(), state = { ...loaded, rows: [...loaded.rows], destinations: [...loaded.destinations] }, set = `set_${seaToPrincipalKey(owner)}_${"4".repeat(32)}`;
  const membership = sign("membership", { role: "set", predicate: "same-group", set, member: old, setOwner: owner,
    stated: 1, hamState: 1, cancels: [], issuedAt: at });
  const group = { soul: membership.soul, set, predicate: "same-group", setOwner: owner };
  state.destinations.push(forum);
  for (const cancelId of ["c".repeat(64), "b".repeat(64), "c".repeat(64)])
    state.rows.push(sign("cancel", { kind: "membership", rowSoul: group.soul, cancelId, prior: [], signer: owner,
      predicate: group.predicate, set, member: old, setOwner: owner, issuedAt: at }));
  const pending = assignmentCancellationIntents(state, id, old, at, { groupMembership: () => group });
  state.rows.length = 0; group.setOwner = other;
  const intents = await pending, cancellations = intents.filter(i => i.kind === "cancel");
  assert.equal(intents.length, 5); assert.equal(cancellations.length, 1);
  assert.deepEqual(cancellations[0].fields.prior, ["b".repeat(64), "c".repeat(64)]);
  assert.equal(cancellations[0].fields.setOwner, owner);
  assert.ok(Object.isFrozen(cancellations[0].fields.prior));
  await assert.rejects(assignmentCancellationIntents(state, id, old, at, { groupMembership: () => group }), /external group/);
});

async function signedPlan(h: Awaited<ReturnType<typeof setup>>) {
  const plan = await h.runtime.plan(owner, id, replacement, 0);
  return { issuedAt: plan.issuedAt, cancellations: plan.cancellations.map(i => sign(i.kind, { ...i.fields })),
    grants: plan.grants.map(i => sign(i.kind, { ...i.fields })) };
}
test("client-signed assignment completes without any runtime signer", async () => {
  const h = await setup(), material = await signedPlan(h);
  const runtime = createDelegationRuntime({ ...h.dependencies, sign: undefined });
  await assert.rejects(runtime.start(owner, id, replacement, 0), /signatures required/);
  assert.equal((await h.journal.load()).revision, 0); assert.equal(h.stores.size, 0);
  h.tick(2);
  const result = await runtime.startSigned(owner, id, replacement, 0, material);
  assert.equal(result.status, "complete", JSON.stringify(result)); assert.equal(h.signed, 0);
  assert.equal((await h.journal.load()).assignee, replacement);
  assert.deepEqual(await runtime.startSigned(owner, id, replacement, 0, material), result);
});
for (const fault of ["signature", "target", "missing", "expired", "future"] as const)
  test(`invalid client material ${fault} is rejected before claim or outbox writes`, async () => {
    const h = await setup(), material = await signedPlan(h);
    if (fault === "signature") material.grants[0].record.sig = "invalid";
    if (fault === "target") material.grants[0] = sign("post", { ...material.grants[0].record, accessor: other });
    if (fault === "missing") material.grants.pop();
    if (fault === "expired") h.tick(301);
    if (fault === "future") h.tick(-1);
    const before = await h.journal.load(), runtime = createDelegationRuntime({ ...h.dependencies, sign: undefined });
    await assert.rejects(runtime.startSigned(owner, id, replacement, 0, material));
    assert.deepEqual(await h.journal.load(), before); assert.equal(h.stores.size, 0); assert.equal(h.signed, 0);
  });
for (const write of [2, 3, 4, 5, 6, 7, 8, 9]) test(`client-signed material survives restart at write ${write}`, async () => {
  const h = await setup(), material = await signedPlan(h), dependencies = { ...h.dependencies, sign: undefined };
  h.failAfter(write, true);
  try { await createDelegationRuntime(dependencies).startSigned(owner, id, replacement, 0, material); } catch { /* lost response */ }
  h.tick(2);
  const restart = createDelegationRuntime(dependencies);
  let done = false;
  for (let n = 0; n < 5; n++) if ((await restart.resume(owner, id, replacement)).status === "complete") { done = true; break; }
  assert.ok(done); assert.equal(h.signed, 0);
  assert.equal((await h.journal.load()).assignee, replacement);
});

test("delayed client signatures still cancel current group membership", async () => {
  const h = await setup(), set = `set_${seaToPrincipalKey(owner)}_${"4".repeat(32)}`;
  await h.runtime.admit(owner, 0, destination, [
    ...(["member", "set"] as const).map(role => sign("membership", { role, predicate: "same-group", set, member: old, setOwner: owner, stated: 1, hamState: 1, cancels: [], issuedAt: at })),
    sign("object-set", { owner, object: destination, predicate: "same-group", set, stated: 1, hamState: 1, cancels: [], issuedAt: at }),
  ]);
  const revision = (await h.journal.load()).revision, plan = await h.runtime.plan(owner, id, replacement, revision);
  const material = { issuedAt: plan.issuedAt, cancellations: plan.cancellations.map(i => sign(i.kind, { ...i.fields })), grants: plan.grants.map(i => sign(i.kind, { ...i.fields })) };
  assert.equal(material.cancellations.length, 3); h.tick(2);
  const result = await createDelegationRuntime({ ...h.dependencies, sign: undefined }).startSigned(owner, id, replacement, revision, material);
  assert.equal(result.status, "complete"); assert.equal(h.signed, 0);
});
test("signed material parser and verifier reject malformed, extra and mismatched records", async () => {
  const h = await setup(), material = await signedPlan(h), plan = await h.runtime.plan(owner, id, replacement, 0), graph = await h.graph();
  for (const bad of [null, [], {}, { ...material, extra: true }, { ...material, issuedAt: -1 },
    { ...material, grants: [] }, { ...material, grants: Array(129).fill(material.grants[0]) },
    { ...material, cancellations: Array(193).fill(material.cancellations[0]) },
    { ...material, grants: [null, material.grants[1]] },
    { ...material, grants: [{ ...material.grants[0], extra: true }, material.grants[1]] },
    { ...material, grants: [{ ...material.grants[0], soul: "wrong" }, material.grants[1]] },
    { ...material, grants: [{ ...material.grants[0], record: { ...material.grants[0].record, issuedAt: at + 1 } }, material.grants[1]] },
    { ...material, grants: [{ ...material.grants[0], record: { ...material.grants[0].record, attest: "untrusted" } }, material.grants[1]] }])
    assert.throws(() => parseAssignmentSignedMaterial(bad));
  assert.throws(() => verifyAssignmentSignedMaterial(material, { ...plan, grants: [] }, graph, at), /changed/);
  assert.throws(() => verifyAssignmentSignedMaterial(material, { ...plan, grants: [...plan.grants].reverse() }, graph, at), /changed/);
  assert.throws(() => verifyAssignmentSignedMaterial(material, plan, { writerKey: () => other }, at), /signature/);
  assert.throws(() => verifyAssignmentSignedMaterial(material, plan, { writerKey: () => null }, at), /signature/);
  for (const time of [NaN, at - 1, at + 301]) assert.throws(() => verifyAssignmentSignedMaterial(material, plan, graph, time), /expired/);
  assert.throws(() => verifyAssignmentSignedMaterial(material, { ...plan, issuedAt: at - 1 }, graph, at), /expired/);
});

test("signed start preserves completed receipts after a later assignment", async () => {
  const h = await setup(), material = await signedPlan(h);
  const runtime = createDelegationRuntime({ ...h.dependencies, sign: undefined });
  const first = await runtime.startSigned(owner, id, replacement, 0, material);
  await h.runtime.start(owner, "b".repeat(32), other, (await h.journal.load()).revision);
  assert.deepEqual(await runtime.startSigned(owner, id, replacement, 0, material), first);
  await assert.rejects(runtime.startSigned(owner, id, other, 0, material), /receipt replacement/);
});
