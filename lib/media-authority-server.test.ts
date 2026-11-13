import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createMediaAuthority } from "./media-authority-server";
import { seaToPrincipalKey } from "./identity/forum-check";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import type { ForumAuthoritySnapshot } from "./identity/forum-authority";
const secret = (n: number) => new Uint8Array(32).fill(n);
const pub = (n: number) => { const p = p256.getPublicKey(secret(n), false); return Buffer.from(p.slice(1,33)).toString("base64url") + "." + Buffer.from(p.slice(33)).toString("base64url"); };
const owner = pub(53), member = pub(54), outsider = pub(55), at = 1700000060;
const squad = { owner, forumId: `media_${seaToPrincipalKey(owner)}_${"a".repeat(32)}`, label: "Synthetic service Squad" };
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

const request = new Request("https://s3r.ch/api/media/object"), signal = new AbortController().signal;
function setup(key: string | null = owner, data = snapshot(), read = async () => data, clock = () => at) {
  return createMediaAuthority({ config, clock, authenticate: async () => key ? { key } : null, read });
}
test("signed current ownership allows upload; reader grant permits read only", async () => {
  assert.equal(await setup()(request, squad.forumId, "write", signal), true);
  assert.equal(await setup()(request, squad.forumId, "read", signal), true);
  assert.equal(await setup(member)(request, squad.forumId, "read", signal), true);
  assert.equal(await setup(member)(request, squad.forumId, "write", signal), false);
  assert.equal(await setup(outsider)(request, squad.forumId, "read", signal), false);
  assert.equal(await setup(null)(request, squad.forumId, "read", signal), false);
});
test("every check reads current authority and cancellation denies an earlier reader", async () => {
  let data = snapshot(), reads = 0;
  const authorize = setup(member, data, async () => { reads++; return data; });
  assert.equal(await authorize(request, squad.forumId, "read", signal), true);
  data = { ...data, rows: [...data.rows, sign("see", { object: squad.forumId, owner, accessor: member, from: 0, until: at + 100, stated: 0, hamState: 2 })] };
  assert.equal(await authorize(request, squad.forumId, "read", signal), false); assert.equal(reads, 2);
});
test("missing, forged, expired and incomplete authority never authorize media", async () => {
  const data = snapshot(), forged = structuredClone(data);
  (forged.rows[0].record as { sig: string }).sig = "forged";
  for (const value of [forged, { ...data, rows: [] }, { ...data, completeThrough: at - 1 },
    { ...data, history: { ...data.history, completeThrough: at - 1 } }])
    assert.equal(await setup(owner, value)(request, squad.forumId, "write", signal), false);
  let now = at;
  const expired = setup(owner, data, async () => { now++; return data; }, () => now);
  assert.equal(await expired(request, squad.forumId, "write", signal), false);
  await assert.rejects(setup(owner, data, async () => { throw Error("unavailable"); })(request, squad.forumId, "read", signal));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(setup()(request, squad.forumId, "read", abort.signal));
});

test("authentication crossing the evaluation second cannot use an expired session", async () => {
  let now = at, reads = 0;
  const authorize = createMediaAuthority({ config, clock: () => now,
    authenticate: async () => { now++; return { key: owner }; },
    read: async () => { reads++; return { ...snapshot(), completeThrough: now }; } });
  assert.equal(await authorize(request, squad.forumId, "read", signal), false);
  assert.equal(reads, 0);
});

test("registered ownership is verified with fresh history and confers no reader grant", async () => {
  const registration = sign("object", { object: squad.forumId, owner }).record as unknown as import("./identity/forum-object-record").UnverifiedObjectRecord;
  const data = { ...snapshot(), rows: [] };
  for (const key of [owner, member, outsider]) {
    const authorize = createMediaAuthority({ config, clock: () => at, authenticate: async () => ({ key }),
      read: async () => data, registration: async () => registration });
    assert.equal(await authorize(request, squad.forumId, "read", signal), key === owner);
    assert.equal(await authorize(request, squad.forumId, "write", signal), key === owner);
  }
  const authorize = createMediaAuthority({ config, clock: () => at, authenticate: async () => ({ key: owner }), read: async () => data });
  assert.equal(await authorize(request, squad.forumId, "write", signal, registration), true);
  assert.equal(await authorize(request, squad.forumId, "read", signal, registration), false);
  assert.equal(await authorize(request, squad.forumId, "write", signal, { ...registration, sig: "forged" }), false);
  assert.equal(await authorize(request, squad.forumId.replace(/a$/, "b"), "write", signal, registration), false);
  const unknown = createMediaAuthority({ config, clock: () => at, authenticate: async () => ({ key: owner }),
    read: async () => ({ ...data, history: { ...data.history, accounts: [] } }) });
  assert.equal(await unknown(request, squad.forumId, "write", signal, registration), false);
});

test("a registration read cannot extend the authority evaluation second", async () => {
  let now = at;
  const registration = sign("object", { object: squad.forumId, owner }).record as unknown as import("./identity/forum-object-record").UnverifiedObjectRecord;
  const authorize = createMediaAuthority({ config, clock: () => now, authenticate: async () => ({ key: owner }), read: async () => snapshot(),
    registration: async () => { now++; return registration; } });
  assert.equal(await authorize(request, squad.forumId, "read", signal), false);
});

test("registration preflight requires an enrolled current owner without loading registrations", async () => {
  let registrationReads = 0;
  for (const key of [owner, member, null]) {
    const authorize = createMediaAuthority({ config, clock: () => at, authenticate: async () => key ? { key } : null,
      read: async () => ({ ...snapshot(), rows: [] }), registration: async () => { registrationReads++; return null; } });
    assert.equal(await authorize(request, squad.forumId, "register", signal), key === owner);
  }
  const unknown = createMediaAuthority({ config, clock: () => at, authenticate: async () => ({ key: owner }),
    read: async () => ({ ...snapshot(), rows: [], history: { ...snapshot().history, accounts: [] } }) });
  assert.equal(await unknown(request, squad.forumId, "register", signal), false);
  assert.equal(registrationReads, 0);
});
