import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import wallet from "./vectors/forum-wallet-link.json";
import witnesses from "./vectors/forum-witness.json";
import { verifyForumWalletLinkProof } from "./forum-wallet-link-proof";
import type { ForumWitnessKey } from "./forum-witness-verification";
const base = wallet.wallet.input;
const keys = witnesses.keys as ForumWitnessKey[];
const policy = { allowedDomains: ['s3r.ch'], allowedUris: ['https://s3r.ch/identity/link'], allowedChainIds: ['1'] };
const verify = (input: unknown, at = base.issuedAt) => verifyForumWalletLinkProof(input, base.principal, keys, policy, at);

test('verifies the complete upstream wallet-link proof bundle', async () => {
  const result = await verify(base);
  assert.ok(result);
  assert.equal(result.linkId, wallet.wallet.linkId);
  assert.deepEqual(result.record, base);
  assert.equal(result.signingKey, base.principal);
  assert.ok(Object.isFrozen(result));
});

test('requires every signature, explicit trust and matching SIWE policy', async () => {
  for (const patch of [
    { keySig: 'forged' }, { attest: 'forged' }, { nonce: 'otherNonce' },
    { siwe: { ...base.siwe, message: base.siwe.message + ' ' } },
    { siwe: { ...base.siwe, signature: '0x' + '00'.repeat(65) } },
  ]) assert.equal(await verify({ ...base, ...patch }), null);
  assert.equal(await verifyForumWalletLinkProof(base, 'invalid', keys, policy, base.issuedAt), null);
  assert.equal(await verifyForumWalletLinkProof(base, base.principal, [], policy, base.issuedAt), null);
  assert.equal(await verifyForumWalletLinkProof(base, base.principal, keys, { ...policy, allowedDomains: [] }, base.issuedAt), null);
});

test('historical evaluation is explicit and does not imply present freshness', async () => {
  assert.ok(await verify(base, base.issuedAt + 599));
  assert.equal(await verify(base, base.issuedAt + 600), null);
  for (const at of [base.issuedAt - 1, -0, -1, NaN, Infinity, 1.5]) assert.equal(await verify(base, at), null);
});

test('valid witness signatures cannot substitute unrelated link claims', async () => {
  const secret = new Uint8Array(32); secret[31] = 7;
  const pub = p256.getPublicKey(secret, false);
  const b64 = (v: string | Uint8Array) => Buffer.from(v).toString('base64url');
  const key: ForumWitnessKey = { kid: 'test', kty: 'EC', crv: 'P-256', x: b64(pub.slice(1,33)), y: b64(pub.slice(33)), notBefore: 0, notAfter: Number.MAX_SAFE_INTEGER };
  const claims = { typ: 'sociacl-wallet-attest-v1', principal: base.principal, linkId: wallet.wallet.linkId, iat: base.issuedAt, exp: base.issuedAt + 600 };
  for (const patch of [{}, { typ: 'sociacl-rotate-attest-v2' }, { principal: 'other' }, { linkId: '0'.repeat(64) }, { iat: base.issuedAt - 1 }, { extra: true }]) {
    const msg = b64(JSON.stringify({ alg: 'ES256', kid: 'test' })) + '.' + b64(JSON.stringify({ ...claims, ...patch }));
    const attest = msg + '.' + b64(p256.sign(new TextEncoder().encode(msg), secret, { prehash: true, format: 'compact' }));
    const result = await verifyForumWalletLinkProof({ ...base, attest }, base.principal, [key], policy, base.issuedAt);
    assert.equal(result !== null, Object.keys(patch).length === 0);
  }
});

test('asynchronous checks use detached record and policy snapshots', async () => {
  const input = structuredClone(base), config = structuredClone(policy);
  const pending = verifyForumWalletLinkProof(input, base.principal, keys, config, base.issuedAt);
  input.siwe.message = 'mutated'; input.attest = 'mutated'; config.allowedDomains.length = 0;
  assert.deepEqual((await pending)!.record, base);
});
