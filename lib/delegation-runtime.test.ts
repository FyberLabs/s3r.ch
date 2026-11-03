import assert from "node:assert/strict";
import { test } from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createAssignmentJournal } from "./delegation-journal";
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
  let signed = 0, writes = 0, failAt = -1, dropAck = false;
  const base = cas();
  const backing = { ...base, async compareAndSwap(etag: string | null, text: string) {
    writes++; if (writes === failAt && !dropAck) throw Error("offline");
    const result = await base.compareAndSwap(etag, text);
    if (writes === failAt && dropAck) throw Error("response lost"); return result;
  } };
  const journal = createAssignmentJournal(backing, () => at);
  await journal.initialize({ forum, owner, assignee: old, destinations: [destination], rows: [
    ...[forum, destination].map(object => sign("object", { owner, object, issuedAt: at - 100 })),
    ...(["post", "see"] as const).map(kind => sign(kind, { owner, object: destination, accessor: old, stated: 1, hamState: 1, from: at - 100, until: at + 1000, issuedAt: at - 100 })),
  ] });
  const stores = new Map<string, { inventory: InventoryStore; cancellations: ReturnType<typeof outbox>; grants: ReturnType<typeof outbox> }>();
  function outbox() { const documents = new Map<string, string>(); return { documents, async read(id: string) { return documents.get(id) ?? null; }, async create(id: string, value: string) { if (!documents.has(id)) documents.set(id, value); } }; }
  const history = async (time: number) => ({ completeThrough: time, links: [], accounts: [owner, old, replacement, other].map(principal => ({ principal, rotations: [], revocations: [], genesisEpubBindings: [] })) });
  const dependencies = { journal, config, clock: () => at, history,
    operationStores(id: string) { let s = stores.get(id); if (!s) { s = { inventory: cas(), cancellations: outbox(), grants: outbox() }; stores.set(id, s); } return s; },
    async sign(kind: AuthorityKind, fields: Record<string, unknown>) { signed++; return sign(kind, fields); },
  };
  const runtime = createDelegationRuntime(dependencies);
  return { journal, runtime, dependencies, stores, backing: base, get signed() { return signed; },
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
  const h = await setup(); await h.runtime.start(owner, id, replacement, 0);
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
