import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import vectors from "./vectors/forum-revoke.json";
import witnesses from "./vectors/forum-witness.json";
import { parseForumRevoke, verifyForumRevokeNow, verifyForumRevokeWitness } from "./forum-revocation";
import type { ForumWitnessKey } from "./forum-witness-verification";
const base = vectors.revoke.input;
const keys = witnesses.keys as ForumWitnessKey[];

test('upstream revocation bytes, identity and signatures match', async () => {
  const parsed = parseForumRevoke(base)!;
  assert.ok(parsed);
  assert.equal(Buffer.from(parsed.bytes).toString('hex'), vectors.revoke.canonical);
  assert.equal(createHash('sha256').update(parsed.bytes).digest('hex'), vectors.revoke.linkId);
  assert.ok(verifyForumRevokeNow(base, base.principal, base.issuedAt));
  assert.ok(await verifyForumRevokeWitness(base, base.principal, keys, base.issuedAt));
});

test('offline revokes are present evidence only and never fall back in witness checks', async () => {
  const { attest: _, ...offline } = base;
  assert.ok(verifyForumRevokeNow(offline, base.principal, base.issuedAt));
  assert.equal(await verifyForumRevokeWitness(offline, base.principal, keys, base.issuedAt), null);
  assert.ok(verifyForumRevokeNow({ ...base, attest: 'forged' }, base.principal, base.issuedAt));
  assert.equal(await verifyForumRevokeWitness({ ...base, attest: 'forged' }, base.principal, keys, base.issuedAt), null);
  assert.equal(await verifyForumRevokeWitness(base, base.principal, [], base.issuedAt), null);
  assert.equal(await verifyForumRevokeWitness(base, base.principal, keys, base.issuedAt + 600), null);
});

test('malformed fields, clocks, accessors and changed signed data fail closed', () => {
  for (const patch of [{ v: 2 }, { kind: 'wallet' }, { principal: 'bad' }, { linkId: 'A'.repeat(64) }, { extra: true }, { attest: undefined }, { keySig: '' }, { issuedAt: -0 }, { issuedAt: 0.5 }]) assert.equal(parseForumRevoke({ ...base, ...patch }), null);
  for (const patch of [{ issuedAt: base.issuedAt - 1 }, { linkId: '0'.repeat(64) }, { keySig: 'forged' }]) assert.equal(verifyForumRevokeNow({ ...base, ...patch }, base.principal, base.issuedAt), null);
  for (const at of [-0, -1, NaN, Infinity, 1.5, base.issuedAt - 1]) assert.equal(verifyForumRevokeNow(base, base.principal, at), null);
  let reads = 0;
  assert.equal(parseForumRevoke(Object.defineProperty({ ...base }, 'linkId', { get() { reads++; return base.linkId; } })), null);
  const proxy = Proxy.revocable({}, {}); proxy.revoke();
  assert.equal(parseForumRevoke(proxy.proxy), null); assert.equal(reads, 0);
  const copy = { ...base }; const result = parseForumRevoke(copy)!;
  copy.linkId = '0'.repeat(64); assert.deepEqual(result.record, base); assert.ok(Object.isFrozen(result.record));
});

test('a signed witness must bind the exact principal, revoke identity and time', async () => {
  const secret = new Uint8Array(32); secret[31] = 7;
  const pub = p256.getPublicKey(secret, false);
  const b64 = (v: string | Uint8Array) => Buffer.from(v).toString('base64url');
  const key: ForumWitnessKey = { kid: 'test', kty: 'EC', crv: 'P-256', x: b64(pub.slice(1,33)), y: b64(pub.slice(33)), notBefore: 0, notAfter: Number.MAX_SAFE_INTEGER };
  const claims = { typ: 'sociacl-revoke-attest-v1', principal: base.principal, recordId: vectors.revoke.linkId, iat: base.issuedAt, exp: base.issuedAt + 600 };
  for (const patch of [{}, { typ: 'sociacl-wallet-attest-v1' }, { principal: 'other' }, { recordId: '0'.repeat(64) }, { iat: base.issuedAt - 1 }, { extra: true }]) {
    const msg = b64(JSON.stringify({ alg: 'ES256', kid: 'test' })) + '.' + b64(JSON.stringify({ ...claims, ...patch }));
    const attest = msg + '.' + b64(p256.sign(new TextEncoder().encode(msg), secret, { prehash: true, format: 'compact' }));
    assert.equal((await verifyForumRevokeWitness({ ...base, attest }, base.principal, [key], base.issuedAt)) !== null, Object.keys(patch).length === 0);
  }
});
