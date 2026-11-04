import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createSquadAssignmentService } from "./squad-assignment-service";
import { createHttpAssignmentClient } from "./assignment-client";
import { createSquadCommitStore } from "./squad-commit-store";
import { createAssignmentJournal } from "./delegation-journal";
import { seaToPrincipalKey } from "./identity/forum-check";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import type { InventoryStore } from "./delegation-inventory";
const secret = (n: number) => new Uint8Array(32).fill(n);
const pub = (n: number) => { const k = p256.getPublicKey(secret(n), false); return Buffer.from(k.slice(1,33)).toString("base64url") + "." + Buffer.from(k.slice(33)).toString("base64url"); };
const owner = pub(53), old = pub(54), replacement = pub(55), at = 1700000060;
const forum = `forum_${seaToPrincipalKey(owner)}_${"a".repeat(32)}`, scope = { forum, owner };
function memory(): InventoryStore { let held: { text: string; etag: string } | null = null, n = 0;
  return { read: async () => held && { ...held }, compareAndSwap: async (etag, text) => {
    if (etag !== (held?.etag ?? null)) return false; held = { text, etag: String(++n) }; return true;
  } };
}
const outbox = () => { const docs = new Map<string, string>(); return { read: async (id: string) => docs.get(id) ?? null,
  create: async (id: string, text: string) => { if (!docs.has(id)) docs.set(id, text); } }; };
const sign = async (kind: AuthorityKind, fields: Record<string, unknown>) => {
  const record = { ...fields, sig: "pending" }, parsed = parseForumAuthority(kind, record)!; assert.ok(parsed);
  record.sig = Buffer.from(p256.sign(parsed.bytes, secret(53), { prehash: true, format: "compact" })).toString("base64url");
  return { kind, soul: parsed.soul, record };
};
const request = (body: unknown, origin = "https://s3r.ch") => new Request("https://s3r.ch/api/squad/assignment", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
async function setup() {
  const seed = createAssignmentJournal(memory(), () => at);
  const state = await seed.initialize({ forum, owner, assignee: old, destinations: [forum], rows: [
    await sign("object", { owner, object: forum, issuedAt: at - 1 }),
    ...await Promise.all((["see", "post"] as const).map(kind => sign(kind, { owner, object: forum, accessor: old, stated: 1, hamState: 1, from: at - 1, until: at + 100, issuedAt: at - 1 }))),
  ] });
  const squad = { owner, forumId: forum, label: "Assignment HTTP" }, source = createSquadCommitStore(memory(), squad, () => at);
  await source.initialize(state, { completeThrough: at, links: [], accounts: [owner, old, replacement].map(principal => ({ principal, rotations: [], revocations: [], genesisEpubBindings: [] })) });
  const stores = new Map<string, { inventory: InventoryStore; cancellations: ReturnType<typeof outbox>; grants: ReturnType<typeof outbox> }>();
  let key: string | null = owner;
  const service = createSquadAssignmentService({ squad, source, origin: "https://s3r.ch", authenticate: async () => key ? { key } : null,
    runtime: { clock: () => at, config: { keys: [], policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIssuers: [] }, sign,
      operationStores(id) { let s = stores.get(id); if (!s) { s = { inventory: memory(), cancellations: outbox(), grants: outbox() }; stores.set(id, s); } return s; } } });
  const client = createHttpAssignmentClient({ base: "/api/squad/assignment", fetch: async (url, init) => {
    const headers = new Headers(init?.headers); headers.set("Origin", "https://s3r.ch");
    return service(String(url).split("/").at(-1) as Parameters<typeof service>[0], new Request(`https://s3r.ch${url}`, { ...init, headers }));
  } });
  return { service, client, source, as: (next: string | null) => { key = next; } };
}
test("HTTP client completes signed reassignment through the shared runtime and replays receipt", async () => {
  const h = await setup(); assert.equal((await h.client.read(scope)).assignee, old);
  const id = "a".repeat(32);
  const result = await h.client.start(scope, id, replacement, 0); assert.equal(result.status, "complete");
  assert.equal((await h.client.read(scope)).assignee, replacement);
  assert.deepEqual(await h.client.resume(scope, id, replacement), result);
  h.as(old); assert.equal((await h.service("read-child", request({ ...scope, id: forum }))).status, 409);
  h.as(replacement); assert.equal(await h.client.readChild(scope, forum), null);
  assert.equal((await h.service("read", request(scope))).status, 403);
});
test("body-supplied actor, wrong scope/origin and missing session cannot mutate", async () => {
  const h = await setup(), command = { ...scope, operationId: "a".repeat(32), replacement, revision: 0 };
  assert.equal((await h.service("start", request({ ...command, actor: owner }))).status, 400);
  assert.equal((await h.service("start", request({ ...command, forum: "other" }))).status, 400);
  assert.equal((await h.service("start", request(command, "https://evil.example"))).status, 403);
  h.as(old); assert.equal((await h.service("start", request(command))).status, 403);
  h.as(null); assert.equal((await h.service("start", request(command))).status, 403);
  assert.equal((await h.source.load()).journal.operation, null);
});
test("responses project only assignment state and malformed oversized requests fail closed", async () => {
  const h = await setup(), res = await h.service("read", request(scope));
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(await res.json()).sort(), ["assignee", "forum", "operation", "owner", "receipts", "revision"]);
  assert.equal((await h.service("start", request({ ...scope, operationId: "bad", replacement, revision: 0 }))).status, 400);
  assert.equal((await h.service("child", request({ ...scope, record: "x".repeat(131073), signature: "SEA" }))).status, 413);
});
