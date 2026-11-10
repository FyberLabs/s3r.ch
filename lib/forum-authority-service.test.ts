import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { squadPilotReady } from "./squad-pilot-server";
import { LedgerEvaluationExpired } from "./squad-commit-store";
import { createForumAuthorityService } from "./forum-authority-service";
import { createHttpForumAuthorityReader } from "./forum-authority-http";
import { seaToPrincipalKey } from "./identity/forum-check";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import type { ForumAuthoritySnapshot } from "./identity/forum-authority";
const secret = (n: number) => new Uint8Array(32).fill(n);
const pub = (n: number) => { const p = p256.getPublicKey(secret(n), false); return Buffer.from(p.slice(1,33)).toString("base64url") + "." + Buffer.from(p.slice(33)).toString("base64url"); };
const owner = pub(53), member = pub(54), outsider = pub(55), at = 1700000060;
const squad = { owner, forumId: `forum_${seaToPrincipalKey(owner)}_${"a".repeat(32)}`, label: "Synthetic service Squad" };
const config = { keys: [], policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIssuers: [] };
const sign = (kind: AuthorityKind, fields: object) => {
  const record = { ...fields, issuedAt: at - 1, sig: "pending" };
  const parsed = parseForumAuthority(kind, record)!; assert.ok(parsed);
  record.sig = Buffer.from(p256.sign(parsed.bytes, secret(53), { prehash: true, format: "compact" })).toString("base64url");
  return { kind, soul: parsed.soul, record };
};
const snapshot = (): ForumAuthoritySnapshot => ({ completeThrough: at, history: { completeThrough: at, links: [],
  accounts: [owner, member, outsider].map(principal => ({ principal, rotations: [], revocations: [], genesisEpubBindings: [] })) },
  rows: [sign("object", { object: squad.forumId, owner }), sign("see", { object: squad.forumId, owner, accessor: member, from: 0, until: at + 100, stated: 1, hamState: 1 })] });
const body = { version: 1, forumId: squad.forumId, owner, evaluatedAt: at };
const request = (value: unknown = body, origin = "https://s3r.ch") => new Request("https://s3r.ch/api/squad/authority", { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(value) });
function setup(key: string | null = member, data = snapshot()) {
  let reads = 0;
  const handle = createForumAuthorityService({ squad, origin: "https://s3r.ch", config, clock: () => at,
    authenticate: async () => key ? { key } : null, read: async () => { reads++; return data; } });
  return { handle, reads: () => reads };
}
test("real signed authority round-trips through HTTP reader for an authenticated member", async () => {
  const h = setup();
  const read = createHttpForumAuthorityReader({ endpoint: "/api/squad/authority", squad, fetch: async (_url, init) => {
    const headers = new Headers(init?.headers); headers.set("Origin", "https://s3r.ch");
    const res = await h.handle(new Request("https://s3r.ch/api/squad/authority", { ...init, headers }));
    assert.equal(res.status, 200); assert.equal(res.headers.get("cache-control"), "no-store"); return res;
  } });
  assert.deepEqual(await read(at, new AbortController().signal), snapshot());
  assert.equal(h.reads(), 1);
});
test("no session, wrong origin and request scope never reach storage", async () => {
  const missing = setup(null); assert.equal((await missing.handle(request())).status, 403); assert.equal(missing.reads(), 0);
  const h = setup();
  assert.equal((await h.handle(request(body, "https://evil.example"))).status, 403);
  for (const b of [{ ...body, owner: outsider }, { ...body, forumId: "other" }, { ...body, evaluatedAt: at - 1 }, { ...body, actor: owner }])
    assert.equal((await h.handle(request(b))).status, 409);
  assert.equal((await h.handle(request({ padding: "a".repeat(2049) }))).status, 413);
  assert.equal(h.reads(), 0);
});
test("outsiders and cancelled members receive no authority snapshot", async () => {
  assert.equal((await setup(outsider).handle(request())).status, 403);
  const data = snapshot();
  const cancelled = { ...data, rows: [...data.rows, sign("see", { object: squad.forumId, owner, accessor: member, from: 0, until: at + 100, stated: 0, hamState: 2 })] };
  const res = await setup(member, cancelled).handle(request());
  assert.equal(res.status, 403); assert.deepEqual(await res.json(), { error: "access" });
});
test("incomplete or forged source evidence fails closed", async () => {
  const data = snapshot();
  assert.equal((await setup(member, { ...data, history: { ...data.history, completeThrough: at - 1 } }).handle(request())).status, 503);
  const rows = structuredClone(data.rows) as { kind: AuthorityKind; soul: string; record: { sig: string } }[];
  rows[0].record.sig = "forged";
  assert.equal((await setup(member, { ...data, rows }).handle(request())).status, 503);
});

test("a snapshot arriving after the evaluation second cannot authorize a response", async () => {
  let now = at;
  const handle = createForumAuthorityService({ squad, origin: "https://s3r.ch", config, clock: () => now,
    authenticate: async () => ({ key: member }), read: async () => { now++; return snapshot(); } });
  assert.equal((await handle(request())).status, 503);
});

test("aborting a stalled request body cancels it without reading storage", async () => {
  const h = setup(), controller = new AbortController(); let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const req = new Request("https://s3r.ch/api/squad/authority", { method: "POST", body: stream,
    headers: { origin: "https://s3r.ch", "content-type": "application/json" }, signal: controller.signal,
    duplex: "half" } as RequestInit);
  const result = h.handle(req);
  await Promise.resolve(); controller.abort();
  assert.equal((await result).status, 503); assert.equal(cancelled, true); assert.equal(h.reads(), 0);
});

test("pilot health rereads the primary ledger after rollover and requires current ownership", async () => {
  const signal = new AbortController().signal;
  for (const outcome of ["valid", "stale", "missing-owner", "expired-again"]) {
    let now = at - 1;
    const reads: number[] = [];
    const ready = await squadPilotReady({ config: { squad, authority: config }, source: {
      async read(second) {
        reads.push(second);
        if (reads.length === 1 || outcome === "expired-again") {
          now++;
          throw new LedgerEvaluationExpired();
        }
        const data = snapshot();
        if (outcome === "stale") return { ...data, completeThrough: at - 1 };
        if (outcome === "missing-owner") return { ...data, rows: [] };
        return data;
      },
    } }, signal, () => now);
    assert.deepEqual(reads, [at - 1, at]);
    assert.equal(ready, outcome === "valid");
  }
});

test("a previously verified signature cannot authorize different row bytes on a fresh read", async () => {
  const data = snapshot();
  assert.equal((await setup(member, data).handle(request())).status, 200);
  const rows = data.rows.map(entry => entry.kind === "see"
    ? { ...entry, record: { ...(entry.record as object), until: at + 999 } } : entry);
  assert.equal((await setup(member, { ...data, rows }).handle(request())).status, 503);
});
