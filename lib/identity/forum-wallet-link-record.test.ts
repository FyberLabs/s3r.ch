import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import vectors from "./vectors/forum-wallet-link.json";
import { parseForumWalletLinkRecord } from "./forum-wallet-link-record";
import { verifyForumKeySignature } from "./forum-key-signature";
const base = vectors.wallet.input;

test('wallet link bytes, ID and key signature match upstream', () => {
  const parsed = parseForumWalletLinkRecord(base)!;
  assert.ok(parsed);
  assert.equal(Buffer.from(parsed.bytes).toString('hex'), vectors.wallet.canonical);
  assert.equal(createHash('sha256').update(parsed.bytes).digest('hex'), vectors.wallet.linkId);
  assert.ok(verifyForumKeySignature(base.principal, base.keySig, parsed.bytes));
  for (const patch of [{ nonce: 'differentNonce' }, { issuedAt: base.issuedAt + 1 }, { address: '0x' + '00'.repeat(20) }]) {
    const changed = parseForumWalletLinkRecord({ ...base, ...patch })!;
    assert.ok(changed);
    assert.equal(verifyForumKeySignature(base.principal, base.keySig, changed.bytes), false);
  }
});

test('strict shape and canonical scalar bounds reject malformed records', () => {
  for (const patch of [
    { v: 2 }, { kind: 'oidc' }, { extra: true }, { principal: 'invalid' },
    { address: base.address.toLowerCase() }, { address: '0x00' },
    ...[-0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1].map(issuedAt => ({ issuedAt })),
    ...['short', 'x'.repeat(129), 'has space', 'get(x)!!'].map(nonce => ({ nonce })),
    ...['', 'x'.repeat(129), ' x', 'x\u200b', 'x\ud800'].map(keySig => ({ keySig })),
    { attest: undefined }, { attest: 'x'.repeat(16385) },
    { siwe: null }, { siwe: { ...base.siwe, extra: true } },
    { siwe: { ...base.siwe, message: 'x'.repeat(8193) } }, { siwe: { ...base.siwe, signature: '0x' } },
  ]) assert.equal(parseForumWalletLinkRecord({ ...base, ...patch }), null);
  for (const input of [null, [], Object.create(base)]) assert.equal(parseForumWalletLinkRecord(input), null);
});

test('snapshots nested data and refuses accessors without invocation', () => {
  const input = structuredClone(base);
  const parsed = parseForumWalletLinkRecord(input)!;
  input.nonce = 'changedNonce'; input.siwe.message = 'changed';
  assert.deepEqual(parsed.record, base);
  assert.ok(Object.isFrozen(parsed.record)); assert.ok(Object.isFrozen(parsed.record.siwe));
  let calls = 0;
  const getter = { get() { calls++; throw Error('read'); } };
  assert.equal(parseForumWalletLinkRecord(Object.defineProperty({ ...base }, 'nonce', getter)), null);
  assert.equal(parseForumWalletLinkRecord({ ...base, siwe: Object.defineProperty({}, 'message', getter) }), null);
  const proxy = Proxy.revocable({}, {}); proxy.revoke();
  assert.equal(parseForumWalletLinkRecord(proxy.proxy), null);
  assert.equal(calls, 0);
});

test('unsigned proof changes preserve the signed ID and require separate verification', () => {
  const parsed = parseForumWalletLinkRecord({ ...base, attest: 'forged', siwe: { message: '', signature: '0x' + '00'.repeat(65) } })!;
  assert.ok(parsed);
  assert.equal(Buffer.from(parsed.bytes).toString('hex'), vectors.wallet.canonical);
  assert.ok(verifyForumKeySignature(base.principal, base.keySig, parsed.bytes));
});
