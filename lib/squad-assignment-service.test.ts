import { signBrowserAssignment } from "./assignment-browser-sign";
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
async function setup(clientSigned = false) {
  const seed = createAssignmentJournal(memory(), () => at);
  const state = await seed.initialize({ forum, owner, assignee: old, destinations: [forum], rows: [
    await sign("object", { owner, object: forum, issuedAt: at - 1 }),
    ...await Promise.all((["see", "post"] as const).map(kind => sign(kind, { owner, object: forum, accessor: old, stated: 1, hamState: 1, from: at - 1, until: at + 100, issuedAt: at - 1 }))),
  ] });
  const squad = { owner, forumId: forum, label: "Assignment HTTP" }, source = createSquadCommitStore(memory(), squad, () => at);
  await source.initialize(state, { completeThrough: at, links: [], accounts: [owner, old, replacement].map(principal => ({ principal, rotations: [], revocations: [], genesisEpubBindings: [] })) });
  const stores = new Map<string, { inventory: InventoryStore; cancellations: ReturnType<typeof outbox>; grants: ReturnType<typeof outbox> }>();
  let key: string | null = owner, now = at, expireOnAbort = false;
  const guardedSource = { ...source, async open(guard?: () => void) {
    const pinned = await source.open(guard);
    return { ...pinned, journal: { ...pinned.journal, async abort(...args: Parameters<typeof pinned.journal.abort>) {
      if (expireOnAbort) now++;
      return pinned.journal.abort(...args);
    } } };
  } };
  const service = createSquadAssignmentService({ squad, source: guardedSource, origin: "https://s3r.ch", authenticate: async () => key ? { key } : null,
    runtime: { clock: () => now, config: { keys: [], policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIssuers: [] }, sign: clientSigned ? undefined : sign,
      operationStores(id) { let s = stores.get(id); if (!s) { s = { inventory: memory(), cancellations: outbox(), grants: outbox() }; stores.set(id, s); } return s; } } });
  const client = createHttpAssignmentClient({ base: "/api/squad/assignment",
    ...(clientSigned ? { signPlan: (plan: unknown, requested: Parameters<typeof signBrowserAssignment>[0]["requested"]) => signBrowserAssignment({ plan, requested,
      pair: { pub: owner, priv: Buffer.from(secret(53)).toString("base64url"), epub: owner, epriv: "unused" },
      config: { keys: [], policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIssuers: [] },
      read: source.read, signal: new AbortController().signal, clock: () => now, approve: async () => true }) } : {}), fetch: async (url, init) => {
    const headers = new Headers(init?.headers); headers.set("Origin", "https://s3r.ch");
    return service(String(url).split("/").at(-1) as Parameters<typeof service>[0], new Request(`https://s3r.ch${url}`, { ...init, headers }));
  } });
  return { service, client, source, expireAbort: () => { expireOnAbort = true; }, as: (next: string | null) => { key = next; } };
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

test("abort crossing the evaluation deadline cannot commit through the pinned journal", async () => {
  const h = await setup(), id = "d".repeat(32);
  const pinned = await h.source.open();
  await pinned.journal.claim(owner, id, replacement, 0);
  h.expireAbort();
  const res = await h.service("abort", request({ ...scope, operationId: id }));
  assert.equal(res.status, 409);
  assert.equal((await h.source.load()).journal.operation?.phase, "cancellations");
});

test("browser WebCrypto signs through authenticated HTTP while the server has no signer", async () => {
  const h = await setup(true), operationId = "f".repeat(32);
  const command = { ...scope, operationId, replacement, revision: 0 };
  assert.equal((await h.service("start", request(command))).status, 409);
  assert.equal((await h.source.load()).journal.operation, null);
  const result = await h.client.start(scope, operationId, replacement, 0);
  assert.equal(result.status, "complete");
  const state = await h.client.read(scope);
  assert.equal(state.assignee, replacement); assert.equal("signedMaterial" in state.operation!, false);
  assert.ok((await h.source.load()).journal.operation?.signedMaterial);
  assert.deepEqual(await h.client.resume(scope, operationId, replacement), result);
});
test("planning and signed submission enforce owner, origin and exact request fields", async () => {
  const h = await setup(true), command = { ...scope, operationId: "a".repeat(32), replacement, revision: 0 };
  for (const action of ["plan", "start-signed"] as const) {
    const body = action === "plan" ? command : { ...command, material: {} };
    assert.equal((await h.service(action, request({ ...body, actor: owner }))).status, 400);
    assert.equal((await h.service(action, request(body, "https://evil.example"))).status, 403);
    h.as(old); assert.equal((await h.service(action, request(body))).status, 403); h.as(owner);
  }
  assert.equal((await h.source.load()).journal.operation, null);
});
