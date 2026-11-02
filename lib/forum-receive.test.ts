import assert from "node:assert/strict";
import test from "node:test";
import { createForumReceiveProofs } from "./forum-receive-proofs";
import { createForumReceiveRetry } from "./forum-receive-retry";
import { commitForumAlarm, parseForumAlarmUpdate, createMeshEventVersions,
  parseForumAgentStatus, forumStatusAdmission,
  retainForumRemoval, cacheForumStatus, type ForumAlarmUpdate } from "./forum-squad";
import { PILOT_AGENTS, PILOT_OWNER, PILOT_FORUM_ID, PILOT_NEEDS } from "./forum-squad-fixture";
import { readForumSignature, signForumRecord } from "./forum-sign";
import { p256 } from "@noble/curves/nist.js";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function setup() {
  const keys = new Map([["owner", "key1"], ["subject", "key2"]]); let ready = true;
  const proofs = createForumReceiveProofs({ key: p => keys.get(p) ?? null, ready: () => ready,
    verify: async (sig, key) => { const [row, signer] = JSON.parse(sig.slice(3)); return signer === key ? row : null; } });
  const sig = (row: object, key = "key1") => "SEA" + JSON.stringify([row, key]);
  return { keys, proofs, sig, ready: (value: boolean) => { ready = value; } };
}
test("receive receipts deny clones, restored cache rows, mutations and stale keys", async () => {
  const h = setup(), scope = h.proofs.begin(), row = await scope.read(h.sig({ body: "signed" }), "owner") as { body: string };
  assert.ok(scope.retain(row)); assert.ok(h.proofs.valid(row));
  assert.equal(h.proofs.valid({ ...row }), false);
  row.body = "tampered"; assert.equal(h.proofs.valid(row), false); row.body = "signed";
  h.keys.set("owner", "rotated"); assert.equal(h.proofs.valid(row), false);
  h.keys.delete("owner"); assert.equal(h.proofs.valid(row), false);
});
test("disconnect fences pending work while retained receipts require fresh authority on reconnect", async () => {
  const h = setup(), scope = h.proofs.begin(), row = await scope.read(h.sig({ rev: 1 }), "owner") as object;
  assert.ok(scope.retain(row)); h.ready(false); h.proofs.interrupt();
  assert.equal(scope.retain({ rev: 2 }), false); assert.equal(h.proofs.valid(row), false);
  h.ready(true); assert.ok(h.proofs.valid(row)); h.proofs.reset(); assert.equal(h.proofs.valid(row), false);
});
test("late verification cannot cross a rotation or reset and bounded in-flight work drains", async () => {
  let key = "old", release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const p = createForumReceiveProofs({ key: () => key, ready: () => true, verify: async () => { await barrier; return { rev: 1 }; } });
  const scopes = Array.from({ length: 32 }, () => p.begin());
  const pending = scopes.map(s => s.read("SEAsig", "owner"));
  assert.equal(await p.begin().read("SEAsig", "owner"), null);
  key = "new"; p.reset(); release(); assert.deepEqual(await Promise.all(pending), Array(32).fill(null));
  assert.ok(await p.begin().read("SEAsig", "owner"));
});
test("subject records inherit owner admission keys and current ownership checks", async () => {
  const h = setup(); let ownerAllowed = true;
  const a = h.proofs.begin(), parent = await a.read(h.sig({ subject: "subject" }), "owner") as object;
  assert.ok(a.retain(parent, () => ownerAllowed));
  const b = h.proofs.begin(), child = await b.read(h.sig({ stated: 0 }, "key2"), "subject") as object;
  assert.ok(b.depend(parent)); assert.ok(b.retain(child));
  h.keys.set("owner", "retired"); assert.equal(h.proofs.valid(child), false);
  h.keys.set("owner", "key1"); ownerAllowed = false;
  assert.equal(h.proofs.valid(parent), false);
  assert.equal(h.proofs.valid(child), false);
  assert.equal(h.proofs.begin().depend(parent), false);
});
test("roster enrollment is private, current-key checked and bounded", async () => {
  const h = setup(), scope = h.proofs.begin(); const row = await scope.read(h.sig({ admitted: true }), "owner") as object;
  assert.equal(h.proofs.enroll("unverified", { ...row }), false); assert.ok(scope.retain(row));
  for (let n = 0; n < 128; n++) assert.ok(h.proofs.enroll(String(n), row));
  assert.equal(h.proofs.enroll("overflow", row), false); assert.ok(h.proofs.enrolled("0"));
  h.keys.set("owner", "new"); assert.equal(h.proofs.enrolled("0"), false);
});
test("retry hints are detached, bounded, nonrenewable and keep removal channels separate", async () => {
  let now = 0; const q = createForumReceiveRetry(() => now), seen: unknown[] = [];
  const raw = { sig: "SEAproof", body: "original", tags: ["help"] };
  assert.ok(q.remember("live:a", raw, row => seen.push(row)));
  raw.body = "mutated"; raw.tags.push("injected");
  assert.ok(q.remember("remove:a", { sig: "SEAremove" }, row => seen.push(row)));
  q.retry(); await flush(); assert.deepEqual(JSON.parse(JSON.stringify(seen[0])), { sig: "SEAproof", body: "original", tags: ["help"] });
  now = 29_999; assert.ok(q.remember("live:a", { sig: "SEAreplay" }, () => {}));
  now = 30_000; assert.equal(q.size(), 0);
  for (let n = 0; n < 256; n++) assert.ok(q.remember(String(n), raw, () => {}));
  assert.equal(q.remember("overflow", raw, () => {}), false); q.clear(); assert.equal(q.size(), 0);
});
test("retry admission rejects accessors, oversized and unsigned inputs without executing getters", () => {
  const q = createForumReceiveRetry(); let reads = 0;
  assert.equal(q.remember("a", { get sig() { reads++; return "SEAproof"; } }, () => {}), false);
  const tags = ["safe"]; Object.defineProperty(tags, "0", { get() { reads++; return "evil"; } });
  assert.ok(q.remember("a", { sig: "SEAproof", tags }, () => {}));
  assert.equal(reads, 0);
  for (const row of [null, {}, { sig: "unsigned" }, { sig: "SEA" + "x".repeat(32768) }]) assert.equal(q.remember("b", row, () => {}), false);
});
test("same-key generation prevents an older deferred callback from committing after a newer event", async () => {
  const q = createForumReceiveRetry(), versions = createMeshEventVersions(), h = setup();
  const gen = versions.bump("need", "a"); let committed = false;
  q.remember("need:a", { sig: h.sig({ rev: 1 }) }, async raw => {
    const scope = h.proofs.begin(); const row = await scope.read((raw as { sig: string }).sig, "owner") as object;
    if (versions.current("need", "a", gen) && scope.current()) committed = scope.retain(row);
  });
  q.retry(); versions.bump("need", "a"); await flush(); assert.equal(committed, false);
});
test("alarm replay floors only rehydrate identical newly verified updates and never drive fan-in themselves", () => {
  const need = PILOT_NEEDS[0], update = parseForumAlarmUpdate({ forumId: PILOT_FORUM_ID, need: need.id, pinned: 1, rev: 4 }, PILOT_FORUM_ID)!;
  assert.ok(update); const unpin: ForumAlarmUpdate = { kind: "unpin", forumId: PILOT_FORUM_ID, rev: 5 };
  assert.equal(commitForumAlarm({ rev: 5, previous: unpin }, update), null);
  assert.equal(commitForumAlarm({ rev: 4 }, update), null);
  assert.ok(commitForumAlarm({ rev: 4, previous: update }, update));
  assert.equal(commitForumAlarm({ rev: 5, previous: unpin }, { ...update, rev: 5 }), null);

  assert.equal(parseForumAlarmUpdate({ forumId: "wrong", pinned: 0, rev: 6 }, PILOT_FORUM_ID), null);
});
test("real SEA owner admission and subject status compose through receive proof receipts", async () => {
  const secret = new Uint8Array(32); secret[31] = 1;
  const point = p256.getPublicKey(secret, false), b64 = (x: Uint8Array) => Buffer.from(x).toString("base64url");
  const pair = { epub: "", epriv: "", pub: `${b64(point.slice(1, 33))}.${b64(point.slice(33))}`, priv: b64(secret) };
  const status = { ...PILOT_AGENTS[0].status, lastUpdate: 10 };
  const p = createForumReceiveProofs({ key: principal => principal === PILOT_OWNER ? pair.pub : null, ready: () => true, verify: readForumSignature });
  const sig = await signForumRecord(status, pair); assert.ok(sig);
  const scope = p.begin(), parsed = parseForumAgentStatus(await scope.read(sig, PILOT_OWNER)); assert.ok(parsed);
  assert.equal(forumStatusAdmission({ status: parsed, mapKey: parsed.seaPubkey, signer: PILOT_OWNER,
    forumOwner: PILOT_OWNER, forumId: PILOT_FORUM_ID, enrolled: false }), "owner");
  assert.ok(scope.retain(parsed)); assert.ok(p.enroll(parsed.seaPubkey, parsed));
  const cache = new Map(); assert.ok(cacheForumStatus(cache, parsed)); assert.ok(p.valid(cache.get(parsed.seaPubkey)));
  const restored = JSON.parse(JSON.stringify(parsed)); assert.equal(p.valid(restored), false);
  assert.equal(forumStatusAdmission({ status: parsed, mapKey: "other", signer: PILOT_OWNER,
    forumOwner: PILOT_OWNER, forumId: PILOT_FORUM_ID, enrolled: false }), "denied");
});

test("session removal floors stay bounded without replays renewing eviction order", () => {
  let floors: ReadonlySet<string> = new Set();
  for (let n = 0; n < 512; n++) floors = retainForumRemoval(floors, String(n));
  const original = floors; floors = retainForumRemoval(floors, "0"); assert.equal(floors, original);
  floors = retainForumRemoval(floors, "new"); assert.equal(floors.size, 512);
  assert.equal(floors.has("0"), false); assert.ok(floors.has("1")); assert.ok(original.has("0"));
});
