import assert from "node:assert/strict";
import test from "node:test";
import wallet from "./vectors/forum-wallet-link.json";
import revokes from "./vectors/forum-revoke.json";
import witnesses from "./vectors/forum-witness.json";
import rotations from "./vectors/forum-rotation-record.json";
import { checkForumWalletLinkEligibility, type ForumRecoveryProvider } from "./forum-wallet-eligibility";
import type { ForumWitnessKey } from "./forum-witness-verification";
const link = wallet.wallet.input, revoke = revokes.revoke.input;
const keys = witnesses.keys as ForumWitnessKey[];
const policy = { allowedDomains: ['s3r.ch'], allowedUris: ['https://s3r.ch/identity/link'], allowedChainIds: ['1'] };
const provider = (revocations: unknown[] = []): ForumRecoveryProvider => (owner, at) => ({ history: { owner, evaluatedAt: at, rotations: [] }, revocations });
const check = (p: ForumRecoveryProvider | null, mode: 'present' | 'historical' = 'historical') => checkForumWalletLinkEligibility(link, p, keys, policy, revoke.issuedAt + 10000, mode);

test('combines historical proof, complete history and revocation evaluation', async () => {
  const result = await check(provider());
  assert.ok(result.ok); assert.equal(result.linkId, wallet.wallet.linkId);
  assert.equal(result.evaluatedAt, revoke.issuedAt + 10000);
  assert.deepEqual(await check(provider([revoke])), { ok: false, reason: 'revoked-link' });
  const { attest: _, ...offline } = revoke;
  assert.ok((await check(provider([offline]))).ok);
  assert.deepEqual(await check(provider([offline]), 'present'), { ok: false, reason: 'revoked-link' });
});

test('old signing keys may retain links but dropped commitments deny', async () => {
  const rotation = rotations.accept[0].input;
  for (const retainedLinks of [[], [wallet.wallet.linkId]]) {
    const p: ForumRecoveryProvider = (owner, at) => ({ history: { owner, evaluatedAt: at, rotations: [{ seq: 1, prevKey: owner, nextKey: rotation.nextKey, issuedAt: rotation.issuedAt, retainedLinks }] }, revocations: [] });
    const result = await check(p);
    assert.equal(result.ok, retainedLinks.length > 0);
    if (!result.ok) assert.equal(result.reason, 'unretained-link');
  }
});

test('unavailable or mismatched history and invalid proofs cannot grant eligibility', async () => {
  assert.deepEqual(await check(null), { ok: false, reason: 'missing-history' });
  assert.deepEqual(await check(() => null), { ok: false, reason: 'missing-history' });
  assert.deepEqual(await check((owner, at) => ({ history: { owner, evaluatedAt: at - 1, rotations: [] }, revocations: [] })), { ok: false, reason: 'missing-history' });
  assert.deepEqual(await check(provider(new Array(1025))), { ok: false, reason: 'missing-history' });
  assert.deepEqual(await checkForumWalletLinkEligibility({ ...link, keySig: 'forged' }, provider(), keys, policy, link.issuedAt, 'historical'), { ok: false, reason: 'bad-proof' });
});

test('invalid entries report diagnostics while valid revocations still deny', async () => {
  const result = await check(provider([null]));
  assert.ok(result.ok); assert.deepEqual(result.diagnostics, [{ index: 0, reason: 'bad-record' }]);
  assert.deepEqual(await check(provider([null, revoke])), { ok: false, reason: 'revoked-link' });
});

test('provider snapshots precede asynchronous proof verification', async () => {
  const rows = [structuredClone(revoke)]; let calls = 0;
  const pending = check((owner, at) => { calls++; return { history: { owner, evaluatedAt: at, rotations: [] }, revocations: rows }; });
  rows[0].keySig = 'mutated'; rows.length = 0;
  assert.deepEqual(await pending, { ok: false, reason: 'revoked-link' }); assert.equal(calls, 1);
});
