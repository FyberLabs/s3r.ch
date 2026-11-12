import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { signBrowserAssignment } from "./assignment-browser-sign";
import { assignmentCancellationIntents, assignmentReplacementIntents } from "./assignment-signing-plan";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { seaToPrincipalKey } from "./identity/forum-check";
import { createForumAuthority } from "./identity/forum-authority";
import { verifyAssignmentSignedMaterial } from "./assignment-signed-material";
const secret = (n: number) => new Uint8Array(32).fill(n);
const pair = (n: number) => { const key = p256.getPublicKey(secret(n), false); const pub = Buffer.from(key.slice(1,33)).toString("base64url") + "." + Buffer.from(key.slice(33)).toString("base64url"); return { pub, priv: Buffer.from(secret(n)).toString("base64url"), epub: pub, epriv: "unused" }; };
const owner = pair(53), old = pair(54), replacement = pair(55), at = 1700000060;
const forum = `forum_${seaToPrincipalKey(owner.pub)}_${"a".repeat(32)}`;
const config = { keys: [], policy: { allowedDomains: [], allowedUris: [], allowedChainIds: [] }, pinnedIssuers: [] };
async function fixture() {
  const sign = (kind: AuthorityKind, fields: object) => { const record = { ...fields, sig: "pending" }, parsed = parseForumAuthority(kind, record)!;
    record.sig = Buffer.from(p256.sign(parsed.bytes, secret(parsed.signer === old.pub ? 54 : 53), { prehash: true, format: "compact" })).toString("base64url"); return { kind, soul: parsed.soul, record }; };
  const snapshot = { completeThrough: at, history: { completeThrough: at, links: [], accounts: [owner, old, replacement].map(p => ({ principal: p.pub, rotations: [], revocations: [], genesisEpubBindings: [] })) }, rows: [
    sign("object", { owner: owner.pub, object: forum, issuedAt: at - 1 }),
    ...(["post", "see"] as const).map(kind => sign(kind, { owner: owner.pub, object: forum, accessor: old.pub, stated: 1, hamState: 1, issuedAt: at - 1, from: at - 1, until: at + 1000 })),
  ] };
  const authority = createForumAuthority(config, () => at); assert.ok((await authority.refresh(snapshot, at)).ok);
  const requested = { forum, owner: owner.pub, operationId: "a".repeat(32), replacement: replacement.pub, revision: 0 };
  const state = { owner: owner.pub, destinations: [forum], rows: snapshot.rows };
  const plan = { version: 1 as const, ...requested, previous: old.pub, issuedAt: at,
    cancellations: await assignmentCancellationIntents(state, requested.operationId, old.pub, at, authority.graph), grants: assignmentReplacementIntents(state, replacement.pub, at) };
  let reads = 0, approvals = 0; const controller = new AbortController();
  const input = { plan, requested, pair: owner, config, signal: controller.signal, clock: () => at,
    read: async () => { reads++; return snapshot; }, approve: async () => { approvals++; return true; } };
  return { input, authority, controller, snapshot, sign, get reads() { return reads; }, get approvals() { return approvals; } };
}
test("WebCrypto signs only the recomputed approved plan and exports no private key", async () => {
  const h = await fixture(); let preview: unknown;
  const material = await signBrowserAssignment({ ...h.input, approve: async p => { preview = p; return true; } });
  assert.deepEqual(verifyAssignmentSignedMaterial(material, h.input.plan, h.authority.graph, at), material);
  assert.equal(h.reads, 1); assert.ok(Object.isFrozen(preview));
  assert.equal(JSON.stringify(material).includes(owner.priv), false);
  assert.deepEqual((preview as { destinations: string[] }).destinations, [forum]);
});
test("decline and disconnect while confirming never request authority or sign", async () => {
  const h = await fixture();
  await assert.rejects(signBrowserAssignment({ ...h.input, approve: async () => false }), /canceled/); assert.equal(h.reads, 0);
  await assert.rejects(signBrowserAssignment({ ...h.input, approve: async () => { h.controller.abort(); return true; } })); assert.equal(h.reads, 0);
});
test("browser refuses mismatched scope and malformed targets before confirmation", async () => {
  const h = await fixture();
  for (const plan of [null, {}, { ...h.input.plan, revision: 1 }, { ...h.input.plan, replacement: old.pub },
    { ...h.input.plan, cancellations: [] }, { ...h.input.plan, cancellations: [{ kind: "post", fields: { object: "invalid" } }, {}] }])
    await assert.rejects(signBrowserAssignment({ ...h.input, plan }));
  assert.equal(h.approvals, 0); assert.equal(h.reads, 0);
});
test("browser rejects forged intents, wrong key, incomplete history and expired plans", async () => {
  const h = await fixture(), plan = { ...structuredClone(h.input.plan), grants: [...h.input.plan.grants] };
  plan.grants[0] = { ...plan.grants[0], fields: { ...plan.grants[0].fields, accessor: old.pub } };
  await assert.rejects(signBrowserAssignment({ ...h.input, plan }), /plan changed/);
  await assert.rejects(signBrowserAssignment({ ...h.input, plan: { ...h.input.plan, grants: [...h.input.plan.grants].reverse() } }), /plan changed/);
  await assert.rejects(signBrowserAssignment({ ...h.input, pair: old }), /authority changed/);
  await assert.rejects(signBrowserAssignment({ ...h.input, read: async () => null }), /unavailable/);
  await assert.rejects(signBrowserAssignment({ ...h.input, read: async () => ({ ...h.snapshot, rows: [] }) }), /authority changed/);
  await assert.rejects(signBrowserAssignment({ ...h.input, clock: () => at + 301 }), /expired/);
  await assert.rejects(signBrowserAssignment({ ...h.input, clock: () => at - 1 }), /expired/);
});
test("caller mutation during confirmation cannot change the signed action", async () => {
  const h = await fixture(), plan = { ...structuredClone(h.input.plan), grants: [...h.input.plan.grants] };
  const signed = await signBrowserAssignment({ ...h.input, plan, approve: async () => { plan.grants[0] = { ...plan.grants[0], fields: { ...plan.grants[0].fields, accessor: old.pub } }; return true; } });
  assert.deepEqual(verifyAssignmentSignedMaterial(signed, h.input.plan, h.authority.graph, at), signed);
});

test("changed intent counts and evaluation deadlines cannot produce a bundle", async () => {
  const h = await fixture();
  await assert.rejects(signBrowserAssignment({ ...h.input, plan: { ...h.input.plan, cancellations: [...h.input.plan.cancellations, h.input.plan.cancellations[0]] } }), /plan changed/);
  await assert.rejects(signBrowserAssignment({ ...h.input, pair: { ...owner, priv: old.priv } }));
  let now = at;
  await assert.rejects(signBrowserAssignment({ ...h.input, clock: () => now, read: async () => { now++; return h.snapshot; } }), /authority changed/);
  const aborted = await fixture();
  await assert.rejects(signBrowserAssignment({ ...aborted.input, read: async () => { aborted.controller.abort(); return aborted.snapshot; } }));
});

test("browser default clock and a deadline crossed during signing are enforced", async t => {
  const h = await fixture(); t.mock.method(Date, "now", () => at * 1000);
  const { clock: _clock, ...input } = h.input;
  await signBrowserAssignment(input);
  let now = at; const original = crypto.subtle.sign.bind(crypto.subtle);
  t.mock.method(crypto.subtle, "sign", async (...args: Parameters<typeof original>) => { const result = await original(...args); now++; return result; });
  await assert.rejects(signBrowserAssignment({ ...h.input, clock: () => now }), /authority expired/);
});

test("confirmation includes group memberships whose revocation affects other objects", async () => {
  const h = await fixture(), set = `set_${seaToPrincipalKey(owner.pub)}_${"b".repeat(32)}`;
  h.snapshot.rows.push(...(["member", "set"] as const).map(role => h.sign("membership", { role, predicate: "same-group", set,
    member: old.pub, setOwner: owner.pub, stated: 1, hamState: 1, cancels: [], issuedAt: at })),
    h.sign("object-set", { owner: owner.pub, object: forum, predicate: "same-group", set, stated: 1, hamState: 1, cancels: [], issuedAt: at }));
  assert.ok((await h.authority.refresh(h.snapshot, at)).ok);
  h.input.plan.cancellations = await assignmentCancellationIntents({ owner: owner.pub, destinations: [forum], rows: h.snapshot.rows },
    h.input.plan.operationId, old.pub, at, h.authority.graph);
  const material = await signBrowserAssignment({ ...h.input, approve: async preview => {
    assert.deepEqual(preview.groupMemberships, [`same-group: ${set}`]); return true;
  } });
  assert.equal(material.cancellations.length, 3);
  const plan = structuredClone(h.input.plan), index = plan.cancellations.length - 1;
  const invalid = { ...plan, cancellations: plan.cancellations.map((row, i) => i === index ? { ...row, fields: { ...row.fields, member: replacement.pub } } : row) };
  await assert.rejects(signBrowserAssignment({ ...h.input, plan: invalid }), /group cancellation/);
});
