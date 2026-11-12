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
