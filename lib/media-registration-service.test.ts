import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { createMediaRegistrationStore } from "./media-registration-store";
import { createMediaRegistrationService } from "./media-registration-service";
import { RecordConflict, type RecordStore, type StoredRecord } from "./record-store";
import { seaToPrincipalKey } from "./identity/forum-check";
import { parseForumObjectRecord } from "./identity/forum-object-record";
import { createMediaAuthority } from "./media-authority-server";

const secret = new Uint8Array(32).fill(53), point = p256.getPublicKey(secret, false);
const owner = Buffer.from(point.slice(1,33)).toString("base64url") + "." + Buffer.from(point.slice(33)).toString("base64url");
const name = "ownership-v1-" + createHash("sha256").update(owner).digest("hex");
const object = `media_${seaToPrincipalKey(owner)}_${"a".repeat(32)}`, at = 1700000060;
function signed(id = object, issuedAt = at - 1) {
  const row = { object: id, owner, issuedAt, sig: "pending" };
  row.sig = Buffer.from(p256.sign(parseForumObjectRecord(row)!.bytes, secret, { prehash: true, format: "compact" })).toString("base64url");
  return row;
}
const request = (body: unknown = signed(), headers: Record<string, string> = {}) => new Request("https://s3r.ch/api/media/" + object, {
  method: "POST", headers: { origin: "https://s3r.ch", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
function setup() {
  const saved = new Map<string, StoredRecord>();
  let revision = 0, conflicts = 0, allowed = true, checks = 0, identity = owner;
  const calls: string[] = [], hooks = { put: () => {} };
  const records: RecordStore = {
    async get(ns, name) { assert.equal(ns, "media"); assert.match(name, /^ownership-v1-[a-f0-9]{64}$/); calls.push("get"); return structuredClone(saved.get(name) ?? null); },
    async put(ns, name, bytes, expected) {
      assert.equal(ns, "media"); assert.ok(name.startsWith("ownership-v1-")); calls.push("put");
      const held = saved.get(name);
      if (conflicts-- > 0 || expected !== (held?.revision ?? null)) throw new RecordConflict();
      const next = { bytes: new Uint8Array(bytes), revision: String(++revision) }; saved.set(name, next); hooks.put(); return next.revision;
    }, async delete() { throw Error("No deletion"); },
  };
  const store = createMediaRegistrationStore(records);
  const verify = createMediaAuthority({ config: { keys: [], policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIssuers: [] },
    clock: () => at, authenticate: async () => allowed ? { key: identity } : null,
    read: async () => ({ completeThrough: at, rows: [], history: { completeThrough: at, links: [], accounts: [...new Set([owner, identity])].map(principal => ({ principal, rotations: [], revocations: [], genesisEpubBindings: [] })) } }) });
  const service = createMediaRegistrationService({ origin: "https://s3r.ch", store,
    preflight: (request, object, signal) => verify(request, object, "register", signal),
    authorize: async (...args) => { checks++; return verify(...args); } });
  return { service, store, calls, hooks, as: (key: string) => { identity = key; }, checks: () => checks, deny: () => { allowed = false; }, conflicts: (n: number) => { conflicts = n; },
    seed: (entries: unknown[]) => { saved.set(name, { bytes: new TextEncoder().encode(JSON.stringify({ version: 1, entries })), revision: String(++revision) }); } };
}
test("signed ownership registers privately and exact retries are idempotent", async () => {
  const h = setup();
  const first = await h.service(request(), object);
  assert.equal(first.status, 201); assert.equal(await first.text(), ""); assert.equal(first.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await h.store.get(object, new AbortController().signal), signed());
  assert.equal((await h.service(request(), object)).status, 201);
  assert.equal(h.calls.filter(c => c === "put").length, 1);
  assert.ok(h.checks() >= 5);
});
test("missing session and forged signatures never reach private storage", async () => {
  const missing = setup(); missing.deny(); assert.equal((await missing.service(request(), object)).status, 403); assert.deepEqual(missing.calls, []);
  const forged = setup(); assert.equal((await forged.service(request({ ...signed(), sig: "forged" }), object)).status, 403); assert.deepEqual(forged.calls, []);
});
test("origin, malformed metadata, wrong address and oversized bodies fail before storage", async () => {
  const h = setup();
  assert.equal((await h.service(request(signed(), { origin: "https://evil.test" }), object)).status, 403);
  assert.equal((await h.service(request(signed(), { "content-type": "text/plain" }), object)).status, 415);
  assert.equal((await h.service(request(signed(), { "content-encoding": "gzip" }), object)).status, 415);
  for (const body of [{ ...signed(), grants: [] }, { ...signed(), object: "bad" }, {}, null])
    assert.equal((await h.service(request(body), object)).status, 400);
  assert.equal((await h.service(request(), object.replace(/a$/, "b"))).status, 400);
  assert.equal((await h.service(request({ padding: "x".repeat(2049) }), object)).status, 413);
  const bad = new Request("https://s3r.ch/api/media/" + object, { method: "POST", headers: { origin: "https://s3r.ch", "content-type": "application/json" }, body: "{" });
  assert.equal((await h.service(bad, object)).status, 400); assert.deepEqual(h.calls, []);
});
test("bounded conflicts retry and an older signature cannot replace a newer record", async () => {
  const h = setup(); h.conflicts(2); assert.equal((await h.service(request(), object)).status, 201);
  assert.equal(h.calls.filter(c => c === "put").length, 3);
  assert.equal((await h.service(request(signed(object, at)), object)).status, 201);
  assert.equal((await h.service(request(), object)).status, 409);
  const blocked = setup(); blocked.conflicts(3); assert.equal((await blocked.service(request(), object)).status, 409);
});
test("registration quota and malformed stored indexes fail closed", async () => {
  const h = setup(); h.seed(Array.from({ length: 8 }, (_, i) => signed(`media_${seaToPrincipalKey(owner)}_${i.toString(16).padStart(32, "0")}`)));
  assert.equal((await h.service(request(), object)).status, 507);
  for (const entries of [[signed(), signed()], [{ ...signed(), unexpected: true }]]) {
    const corrupt = setup(); corrupt.seed(entries); assert.equal((await corrupt.service(request(), object)).status, 503);
  }
});
test("authority loss after storage refuses success and stored signatures grant no ongoing access", async () => {
  const h = setup(); h.hooks.put = h.deny;
  assert.equal((await h.service(request(), object)).status, 403);
  assert.equal((await h.service(request(), object)).status, 403);
});
test("abort cancels stalled bodies and concurrent requests are bounded", async () => {
  const h = setup(), controllers = [new AbortController(), new AbortController()]; let cancelled = 0;
  let entered!: () => void, readingCount = 0;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const pending = controllers.map(controller => h.service(new Request("https://s3r.ch/api/media/" + object, {
    method: "POST", headers: { origin: "https://s3r.ch", "content-type": "application/json" },
    body: new ReadableStream({ pull() { if (++readingCount === 2) entered(); }, cancel() { cancelled++; } }, { highWaterMark: 0 }), signal: controller.signal, duplex: "half" } as RequestInit), object));
  await reading;
  assert.equal((await h.service(request(), object)).status, 429);
  // Changing the object suffix cannot evade the owner's body-read limit.
  assert.equal((await h.service(request(), object.replace(/a$/, "b"))).status, 429);
  const otherSecret = new Uint8Array(32).fill(54), point = p256.getPublicKey(otherSecret, false);
  const other = Buffer.from(point.slice(1,33)).toString("base64url") + "." + Buffer.from(point.slice(33)).toString("base64url");
  const next = { object: `media_${seaToPrincipalKey(other)}_${"b".repeat(32)}`, owner: other, issuedAt: at - 1, sig: "pending" };
  next.sig = Buffer.from(p256.sign(parseForumObjectRecord(next)!.bytes, otherSecret, { prehash: true, format: "compact" })).toString("base64url");
  h.as(other);
  assert.equal((await h.service(request(next), next.object)).status, 201);
  assert.equal((await h.service(new Request(request(next), { method: "DELETE" }), next.object)).status, 204);
  h.as(owner);
  controllers.forEach(controller => controller.abort());
  assert.deepEqual((await Promise.all(pending)).map(r => r.status), [503, 503]); assert.equal(cancelled, 2);
  assert.equal((await h.service(request(), object)).status, 201);
});

test("one owner's full partition cannot consume another owner's registrations", async () => {
  const h = setup();
  h.seed(Array.from({ length: 8 }, (_, i) => signed(`media_${seaToPrincipalKey(owner)}_${i.toString(16).padStart(32, "0")}`)));
  assert.equal((await h.service(request(), object)).status, 507);
  const otherSecret = new Uint8Array(32).fill(54), point = p256.getPublicKey(otherSecret, false);
  const other = Buffer.from(point.slice(1,33)).toString("base64url") + "." + Buffer.from(point.slice(33)).toString("base64url");
  const next = { object: `media_${seaToPrincipalKey(other)}_${"b".repeat(32)}`, owner: other, issuedAt: at - 1, sig: "pending" };
  next.sig = Buffer.from(p256.sign(parseForumObjectRecord(next)!.bytes, otherSecret, { prehash: true, format: "compact" })).toString("base64url");
  h.as(other);
  assert.equal((await h.service(request(next), next.object)).status, 201);
  assert.deepEqual(await h.store.get(next.object, new AbortController().signal), next);
  assert.equal((await h.service(request(), object)).status, 403);
});
test("authenticated cleanup reclaims a registration slot and supports conditional retries", async () => {
  const h = setup(); await h.service(request(), object);
  const remove = (body = signed()) => new Request(request(body), { method: "DELETE" });
  const before = h.calls.length;
  assert.equal((await h.service(remove({ ...signed(), sig: "forged" }), object)).status, 403);
  assert.equal(h.calls.length, before);
  h.conflicts(3); assert.equal((await h.service(remove(), object)).status, 409);
  assert.ok(await h.store.get(object, new AbortController().signal));
  h.conflicts(1); assert.equal((await h.service(remove(), object)).status, 204);
  assert.equal(await h.store.get(object, new AbortController().signal), null);
  assert.equal((await h.service(remove(), object)).status, 204);
  assert.equal((await h.service(request(), object)).status, 201);
  h.deny(); assert.equal((await h.service(remove(), object)).status, 403);
});

test("unauthenticated stalled bodies are refused before reading or consuming capacity", async () => {
  const h = setup(); h.deny(); let pulls = 0, cancelled = 0;
  for (let i = 0; i < 3; i++) {
    const req = new Request("https://s3r.ch/api/media/" + object, { method: "POST",
      headers: { origin: "https://s3r.ch", "content-type": "application/json" },
      body: new ReadableStream({ pull() { pulls++; }, cancel() { cancelled++; } }, { highWaterMark: 0 }), duplex: "half" } as RequestInit);
    assert.equal((await h.service(req, object)).status, 403);
  }
  assert.equal(pulls, 0); assert.equal(cancelled, 3); assert.deepEqual(h.calls, []);
});

test("global body admission stays bounded across owners and releases aborted slots", async () => {
  const h = setup(), controllers: AbortController[] = [], pending: Promise<Response>[] = [];
  let cancelled = 0;
  for (let i = 0; i < 8; i++) {
    const key = p256.getPublicKey(new Uint8Array(32).fill(60 + i), false);
    const principal = Buffer.from(key.slice(1, 33)).toString("base64url") + "." + Buffer.from(key.slice(33)).toString("base64url");
    h.as(principal);
    const id = `media_${seaToPrincipalKey(principal)}_${"a".repeat(32)}`;
    for (let j = 0; j < 2; j++) {
      const controller = new AbortController(); controllers.push(controller);
      let entered!: () => void;
      const reading = new Promise<void>(resolve => { entered = resolve; });
      const req = new Request("https://s3r.ch/api/media/" + id, { method: "POST",
        headers: { origin: "https://s3r.ch", "content-type": "application/json" },
        body: new ReadableStream({ pull() { entered(); }, cancel() { cancelled++; } }, { highWaterMark: 0 }),
        signal: controller.signal, duplex: "half" } as RequestInit);
      pending.push(h.service(req, id));
      await reading;
    }
  }
  h.as(owner);
  assert.equal((await h.service(request(), object)).status, 429);
  controllers.forEach(controller => controller.abort());
  assert.deepEqual((await Promise.all(pending)).map(response => response.status), Array(16).fill(503));
  assert.equal(cancelled, 16);
  assert.equal((await h.service(request(), object)).status, 201);
});

test("preflight authority reads have a separate bounded admission pool", async () => {
  let release!: () => void, reads = 0, cancelled = 0;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const source = createMediaRegistrationService({ origin: "https://s3r.ch", store: setup().store,
    preflight: async () => { reads++; await hold; return false; }, authorize: async () => { throw Error("Not reached"); } });
  const make = () => new Request("https://s3r.ch/api/media/" + object, { method: "POST",
    headers: { origin: "https://s3r.ch", "content-type": "application/json" },
    body: new ReadableStream({ cancel() { cancelled++; } }), duplex: "half" } as RequestInit);
  const first = source(make(), object), second = source(make(), object);
  assert.equal((await source(make(), object)).status, 429);
  assert.equal(reads, 2);
  release(); assert.equal((await first).status, 403); assert.equal((await second).status, 403);
  assert.equal((await source(make(), object)).status, 403);
  assert.equal(reads, 3); assert.equal(cancelled, 4);
});
