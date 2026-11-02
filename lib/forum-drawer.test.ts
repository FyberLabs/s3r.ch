import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createForumDrawer, drawerSoul, parseDrawerRecord, DRAWER_LIMIT, DRAWER_PENDING_MS, type DrawerRecord } from "./forum-drawer";
import { createForumAuthority, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { seaToPrincipalKey, forumAgentSoul } from "./identity/forum-check";
import type { FeedGun } from "../components/GunPeerProvider";
import type { ForumWitnessKey } from "./identity/forum-witness-verification";
import vectors from "./identity/vectors/forum-authority.json";
import { readForumSignature, signForumRecord } from "./forum-sign";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const secret = (n: number) => { const b = new Uint8Array(32); b[31] = n; return b; };
const pub = (n: number) => { const b = p256.getPublicKey(secret(n), false); return b64(b.slice(1, 33)) + "." + b64(b.slice(33)); };
const owner = pub(1), writer = pub(2), outsider = pub(3), time = 1700000060;
const id = (kind: string, key = 1, n = 1) => `${kind}_${seaToPrincipalKey(pub(key))}_${n.toString(16).padStart(32, "0")}`;
const forum = id("forum"), child = id("update"), target = id("spec");
const config = { keys: vectors.context.jwks.keys as ForumWitnessKey[], policy: vectors.context.policy, pinnedIssuers: vectors.context.pinnedIss };
type Evidence = ForumAuthoritySnapshot["rows"][number];
function proof(kind: AuthorityKind, fields: Record<string, unknown>, key = 1): Evidence {
  const row = { issuedAt: time - 10, ...fields, sig: "pending" };
  const parsed = parseForumAuthority(kind, row); assert.ok(parsed);
  row.sig = b64(p256.sign(parsed.bytes, secret(key), { prehash: true, format: "compact" }));
  return { kind, soul: parsed.soul, record: row };
}
const owned = (object = child, key = 1, principal = owner) => proof("object", { object, owner: principal }, key);
const grant = (kind: "see" | "post", object = child, accessor = writer, stated = 1, hamState = 1) =>
  proof(kind, { owner, object, accessor, stated, hamState, from: 0, until: time + 100 });
const snapshot = (rows: readonly Evidence[], at = time): ForumAuthoritySnapshot => ({ completeThrough: at,
  rows, history: { completeThrough: at, links: [], accounts: [owner, writer, outsider].map(principal =>
    ({ principal, rotations: [], revocations: [], genesisEpubBindings: [] })) } });
const record = (changes: Partial<DrawerRecord> = {}): DrawerRecord => ({ domain: "s3rch-forum-child-v1", kind: "update",
  forumId: forum, agent: owner, id: child, writer, rev: 1, issuedAt: time - 1, stated: 1, body: "verified update", state: "", target: "", ...changes });
const signature = (row: unknown, key = writer) => "SEA" + JSON.stringify([row, key]);
// A controlled proof boundary for interleaving tests. The actual SEA codec is
// exercised separately below; ACL evidence always uses real P-256 signatures.
const verify = async (sig: string, key: string) => { const [row, signedKey] = JSON.parse(sig.slice(3)); return key === signedKey ? row : null; };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
class Wire {
  callbacks = new Map<string, Set<(data: unknown, key: string) => void>>();
  paths: string[][] = [];
  puts: { path: string; value: unknown }[] = [];
  node(parts: string[] = []): FeedGun {
    const path = parts.join("/");
    const listen = (name: string, cb: (data: unknown, key: string) => void) => {
      const set = this.callbacks.get(name) ?? new Set(); set.add(cb); this.callbacks.set(name, set);
      return { off: () => { set.delete(cb); } };
    };
    return { get: key => { this.paths.push([...parts, key]); return this.node([...parts, key]); },
      put: value => { this.puts.push({ path, value }); this.emit(path, value); return this.node(parts); },
      on: cb => listen(path, cb), map: () => ({ on: cb => listen(path + "/*", cb) }) };
  }
  emit(path: string, value: unknown) {
    const segments = path.split("/"), key = segments.pop()!;
    for (const fn of this.callbacks.get(segments.join("/") + "/*") ?? []) fn(value, key);
    for (const fn of this.callbacks.get(path) ?? []) fn(value, key);
  }
}
async function setup(evidence: readonly Evidence[] = [owned(), grant("see"), grant("post")], verifier = verify) {
  let now = time, ms = time * 1000, active = true, viewer: string | null = writer;
  const authority = createForumAuthority(config, () => now);
  assert.ok((await authority.refresh(snapshot(evidence), now)).ok);
  const wire = new Wire();
  const c = createForumDrawer({ forum, agent: owner, authority, verify: verifier, clock: () => now, millis: () => ms,
    viewer: () => viewer, active: () => active });
  c.connect(wire.node());
  return { c, authority, wire,
    setClock: (n: number) => { now = n; }, setMillis: (n: number) => { ms = n; },
    setActive: (a: boolean) => { active = a; }, setViewer: (v: string | null) => { viewer = v; },
    async send(row = record(), options: { key?: string; path?: string; tail?: boolean } = {}) {
      wire.emit(options.path ?? drawerSoul(row) + (options.tail ? "/remove" : ""), { ...row, sig: signature(row, options.key) });
      await flush();
    } };
}
test("all drawer kinds traverse complete SEA keys and display only verified children", async () => {
  const rows = (["subtask", "update", "prompt", "artifact"] as const).map(kind =>
    record({ kind, id: id(kind), state: kind === "subtask" ? "done" : "", target: kind === "artifact" ? target : "" }));
  const h = await setup([...rows.flatMap(r => [owned(r.id), grant("see", r.id), grant("post", r.id)]), owned(target), grant("see", target)]);
  for (const row of rows) await h.send(row);
  assert.equal(h.c.rows().length, 4);
  assert.ok(h.wire.paths.some(p => p.includes(owner)));
  assert.ok(h.wire.paths.every(p => !p.includes(owner.split(".")[0])));
  const result = await h.c.publish(record({ rev: 2 }), { key: writer, sign: async r => signature(r) });
  assert.equal(result, "signed"); await flush();
  assert.equal(h.c.rows().find(r => r.id === child)?.rev, 2);
  assert.equal(h.wire.puts[0].path, drawerSoul(record()));
  h.c.dispose();
});
test("actual SEA signature verifies through the subscribed transport path", async () => {
  const h = await setup(undefined, readForumSignature);
  const row = record(), pair = { pub: writer, priv: b64(secret(2)), epub: writer, epriv: b64(secret(2)) };
  const sig = await signForumRecord(row, pair); assert.ok(sig);
  const received = new Promise<void>(resolve => { const off = h.c.subscribe(() => { if (h.c.rows().length) { off(); resolve(); } }); });
  h.wire.emit(drawerSoul(row), { ...row, sig });
  await received;
  assert.equal(h.c.rows()[0].body, row.body);
  h.c.dispose();
});
test("foreign agent/forum/key substitution and malformed or unsigned data cannot replace evidence", async () => {
  const h = await setup(); await h.send();
  const original = h.c.rows()[0];
  for (const bad of [record({ agent: outsider }), record({ forumId: id("forum", 3) }),
    record({ id: id("update", 3) }), record({ writer: outsider }), record({ rev: -1 }), record({ issuedAt: time + 1 })]) {
    await h.send(bad, { path: drawerSoul(record()) });
    assert.deepEqual(h.c.rows(), [original]);
  }
  for (const bad of [null, {}, { ...record({ body: "unsigned" }) }, { ...record(), sig: "SEAforged" }]) {
    h.wire.emit(drawerSoul(record()), bad); await flush(); assert.deepEqual(h.c.rows(), [original]);
  }
  // Unsigned siblings cannot replace the body authenticated inside sig.
  h.wire.emit(drawerSoul(record()), { ...record(), body: "tampered", sig: signature(record()) });
  await flush(); assert.deepEqual(h.c.rows(), [original]);
  h.c.dispose();
});
test("first create waits for signed object admission and rechecks after signing", async () => {
  const h = await setup([grant("see"), grant("post")]);
  await h.send(); assert.equal(h.c.rows().length, 0);
  let signs = 0;
  assert.equal(await h.c.publish(record(), { key: writer, sign: async r => { signs++; return signature(r); } }), "denied");
  assert.equal(signs, 0);
  await h.authority.refresh(snapshot([owned(), grant("see"), grant("post")]), time);
  await flush(); assert.equal(h.c.rows().length, 1);
  let finish!: (sig: string) => void;
  const pending = h.c.publish(record({ rev: 2 }), { key: writer, sign: () => new Promise(resolve => { finish = resolve; }) });
  h.authority.invalidate(); finish(signature(record({ rev: 2 })));
  assert.equal(await pending, "denied"); assert.equal(h.wire.puts.length, 0);
  assert.equal(h.c.rows().length, 0);
  h.c.dispose();
});
test("see and post cancellation each hide received rows and deny publication", async () => {
  for (const kind of ["see", "post"] as const) {
    const h = await setup(); await h.send();
    await h.authority.refresh(snapshot([owned(), grant("see"), grant("post"), grant(kind, child, writer, 0, 2)]), time);
    assert.equal(h.c.rows().length, 0);
    assert.equal(await h.c.publish(record({ rev: 2 }), { key: writer, sign: async r => signature(r) }), "denied");
    h.c.dispose();
  }
});
test("referenced artifacts require separate current writer and viewer reads", async () => {
  const row = record({ kind: "artifact", id: id("artifact"), target, writer: owner });
  const base = [owned(row.id), grant("see", row.id), owned(target)];
  const h = await setup(base); await h.send(row, { key: owner });
  assert.equal(h.c.rows().length, 0);
  await h.authority.refresh(snapshot([...base, grant("see", target)]), time);
  assert.equal(h.c.rows().length, 1);
  await h.authority.refresh(snapshot([...base, grant("see", target, writer, 0, 2)]), time);
  assert.equal(h.c.rows().length, 0);
  // Giving the writer access to the artifact record is not target access.
  const otherTarget = id("spec", 3);
  const other = record({ kind: "artifact", id: row.id, target: otherTarget, writer: owner, rev: 2 });
  await h.authority.refresh(snapshot([...base, owned(otherTarget, 3, outsider)]), time);
  assert.equal(await h.c.publish(other, { key: owner, sign: async r => signature(r, owner) }), "denied");
  h.c.dispose();
});
test("late verification, stale revisions and unsigned nulls cannot undo a removal", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const h = await setup(undefined, async (sig, key) => {
    const row = await verify(sig, key);
    if (row?.body === "slow") await barrier;
    return row;
  });
  h.wire.emit(drawerSoul(record()), { ...record(), sig: signature(record({ body: "slow", rev: 1 })) });
  await h.send(record({ rev: 2 }));
  await h.send(record({ rev: 2, stated: 0 }), { tail: true });
  release(); await flush(); assert.equal(h.c.rows().length, 0);
  await h.send(record({ rev: 2 })); assert.equal(h.c.rows().length, 0);
  h.wire.emit(drawerSoul(record()) + "/remove", null); await flush();
  assert.equal(h.c.rows().length, 0); assert.equal(h.c.revision(child), 2);
  await h.send(record({ rev: 3 })); assert.equal(h.c.rows()[0].rev, 3);
  h.c.dispose();
});
test("removal publication persists its tail first and tolerates self-echo", async () => {
  const h = await setup(); await h.send();
  const row = record({ rev: 2, stated: 0 });
  assert.equal(await h.c.publish(row, { key: writer, sign: async r => signature(r) }), "signed");
  await flush();
  assert.deepEqual(h.wire.puts.map(p => p.path), [drawerSoul(row) + "/remove", drawerSoul(row)]);
  assert.equal(h.c.rows().length, 0);
  h.c.dispose();
});
test("reconnect needs fresh verification while retaining replay floors", async () => {
  const h = await setup(); await h.send(record({ rev: 3 }));
  h.c.disconnect(); assert.equal(h.c.rows().length, 0);
  h.c.connect(h.wire.node()); assert.equal(h.c.rows().length, 0);
  await h.send(record({ rev: 2 })); assert.equal(h.c.rows().length, 0);
  await h.send(record({ rev: 3 })); assert.equal(h.c.rows().length, 1);
  h.setActive(false); assert.equal(h.c.rows().length, 0);
  h.setActive(true); h.setViewer(null); assert.equal(h.c.rows().length, 0);
  h.setViewer(writer); h.setClock(time + 1); assert.equal(h.c.rows().length, 0);
  h.c.dispose();
});
test("disconnect fences an in-flight signature and publication", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const h = await setup(undefined, async (sig, key) => { await barrier; return verify(sig, key); });
  h.wire.emit(drawerSoul(record()), { ...record(), sig: signature(record()) });
  let finish!: (sig: string) => void;
  const publish = h.c.publish(record(), { key: writer, sign: () => new Promise(resolve => { finish = resolve; }) });
  h.c.disconnect(); h.c.connect(h.wire.node()); release(); finish(signature(record()));
  assert.equal(await publish, "denied"); await flush(); assert.equal(h.c.rows().length, 0);
  assert.equal(h.wire.puts.length, 0); h.c.dispose();
});
test("rotation hides old-key rows and accepts the new key without changing owner/path", async () => {
  const h = await setup([owned()]);
  h.setViewer(owner);
  await h.send(record({ writer: owner }), { key: owner }); assert.equal(h.c.rows().length, 1);
  const input = snapshot([owned(child, 2)]);
  const rotated = { ...input, history: { completeThrough: time, links: vectors.context.links.map(([, r]) => r),
    accounts: vectors.context.authenticatedAccounts.filter(principal => principal !== writer).map(principal => ({ principal,
      rotations: principal === owner ? vectors.context.rotationSets.rotated : [], revocations: [], genesisEpubBindings: [] })) } };
  assert.ok((await h.authority.refresh(rotated, time)).ok);
  assert.equal(h.c.rows().length, 0);
  assert.equal(h.authority.graph.principalForKey(writer, time), owner);
  await h.send(record({ writer: owner, rev: 2 }), { key: writer });
  assert.equal(h.c.rows()[0].agent, owner);
  assert.equal(h.authority.graph.ownerOf(child), owner);
  assert.equal(h.c.rows()[0].id, child);
  await h.send(record({ writer: owner, rev: 3 }), { key: owner });
  assert.equal(h.c.rows()[0].rev, 2);
  h.c.dispose();
});
test("bounded pending hints expire without becoming display evidence", async () => {
  const h = await setup([]);
  await h.send(); assert.equal(h.c.rows().length, 0);
  h.setMillis(time * 1000 + DRAWER_PENDING_MS);
  h.c.refresh();
  await h.authority.refresh(snapshot([owned(), grant("see"), grant("post")]), time); await flush();
  assert.equal(h.c.rows().length, 0);
  await h.send(); assert.equal(h.c.rows().length, 1);
  h.c.dispose();
});
test("capacity refuses new IDs without evicting signed removal floors", async () => {
  const children = Array.from({ length: DRAWER_LIMIT + 1 }, (_, i) => id("update", 1, i + 1));
  const h = await setup(children.map(object => owned(object)));
  h.setViewer(owner);
  for (const object of children) await h.send(record({ id: object, writer: owner, stated: 0 }), { key: owner });
  assert.equal(h.c.revision(children[DRAWER_LIMIT - 1]), 1);
  assert.equal(h.c.revision(children[DRAWER_LIMIT]), -1);
  await h.send(record({ writer: owner }), { key: owner }); assert.equal(h.c.rows().length, 0);
  h.c.dispose();
});
test("parser snapshots own data and rejects getters, extras and unsafe identities", () => {
  const mutable = record(); const parsed = parseDrawerRecord(mutable); assert.ok(parsed && Object.isFrozen(parsed));
  for (const bad of [{ ...record(), extra: true }, { ...record(), rev: Number.MAX_SAFE_INTEGER + 1 },
    { ...record(), target }, { ...record(), id: child + "/nested" },
    { ...record(), get body() { throw Error("must not execute"); } }]) assert.equal(parseDrawerRecord(bad), null);
});

test("grant loss while proof verification is suspended cannot commit a row", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const h = await setup(undefined, async (sig, key) => { await barrier; return verify(sig, key); });
  h.wire.emit(drawerSoul(record()), { ...record(), sig: signature(record()) });
  await h.authority.refresh(snapshot([owned(), grant("see"), grant("post", child, writer, 0, 2)]), time);
  release(); await flush();
  assert.equal(h.c.rows().length, 0);
  assert.equal(h.c.revision(child), -1);
  h.c.dispose();
});

test("live rows on the removal tail and cross-collection records are refused", async () => {
  const h = await setup();
  // A valid row opens its bounded removal subscription.
  await h.send();
  await h.send(record({ rev: 2 }), { tail: true });
  assert.equal(h.c.revision(child), 1);
  const path = forumAgentSoul(forum, owner) + "/subtasks/" + child;
  await h.send(record({ rev: 3 }), { path });
  assert.equal(h.c.revision(child), 1);
  h.c.dispose();
});

test("schema never executes object coercion hooks", () => {
  const bad = { toString() { throw Error("must not execute"); } };
  assert.equal(parseDrawerRecord({ ...record(), kind: bad }), null);
  assert.equal(parseDrawerRecord({ ...record({ kind: "subtask", id: id("subtask") }), state: bad }), null);
});

test("a saturated reconnect queues all bounded children and preserves the removal channel", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const children = Array.from({ length: DRAWER_LIMIT }, (_, i) => id("update", 1, i + 1));
  const h = await setup(children.map(object => owned(object)), async (sig, key) => { await barrier; return verify(sig, key); });
  h.setViewer(owner);
  for (const object of children) {
    const row = record({ id: object, writer: owner });
    h.wire.emit(drawerSoul(row), { ...row, sig: signature(row, owner) });
  }
  const last = record({ id: children.at(-1)!, writer: owner });
  h.wire.emit(drawerSoul(last) + "/remove", { ...last, sig: signature({ ...last, stated: 0 }, owner) });
  // A replay on the main channel must not displace the queued signed removal.
  h.wire.emit(drawerSoul(last), { ...last, sig: signature(last, owner) });
  release(); await flush();
  assert.equal(h.c.rows().length, DRAWER_LIMIT - 1);
  assert.equal(h.c.revision(last.id), 1);
  assert.ok(!h.c.rows().some(r => r.id === last.id));
  assert.equal(h.c.atCapacity(), true);
  h.c.dispose();
});

test("an admitted child discovers a standalone removal even when its main put was lost", async () => {
  const h = await setup();
  await h.send(record({ rev: 4, stated: 0 }), { tail: true });
  assert.equal(h.c.revision(child), 4);
  await h.send(record({ rev: 3 })); assert.equal(h.c.rows().length, 0);
  h.c.dispose();
});

test("identity changes during signing fence publication", async () => {
  const h = await setup();
  let finish!: (sig: string) => void;
  const pending = h.c.publish(record(), { key: writer, sign: () => new Promise(resolve => { finish = resolve; }) });
  h.setViewer(null); finish(signature(record()));
  assert.equal(await pending, "denied");
  assert.equal(h.wire.puts.length, 0);
  h.c.dispose();
});

test("reconnect accepts a new valid signature of the same winning payload", async () => {
  const h = await setup(); await h.send();
  h.c.disconnect(); h.c.connect(h.wire.node());
  assert.equal(h.c.rows().length, 0);
  // Distinct signature envelopes authenticate exactly the same semantic row.
  h.wire.emit(drawerSoul(record()), { ...record(), sig: signature(record()) + " " });
  await flush();
  assert.equal(h.c.rows().length, 1);
  assert.equal(h.c.rows()[0].body, record().body);
  h.c.dispose();
});
