import assert from "node:assert/strict";
import test from "node:test";
import revoke from "./vectors/forum-revoke.json";
import wallet from "./vectors/forum-wallet-link.json";
import witnesses from "./vectors/forum-witness.json";
import { checkForumLinkRevocations } from "./forum-link-revocations";
import type { ForumWitnessKey } from "./forum-witness-verification";
const r = revoke.revoke.input;
const target = { principal: wallet.wallet.input.principal, linkId: wallet.wallet.linkId, issuedAt: wallet.wallet.input.issuedAt };
const keys = witnesses.keys as ForumWitnessKey[];
const check = (rows: unknown, mode: 'present' | 'historical' = 'historical', at = r.issuedAt + 10000) => checkForumLinkRevocations(target, rows, r.principal, keys, at, mode);

test('witnessed revocations remain historical evidence after witness expiry', async () => {
  assert.deepEqual(await check([r]), { ok: true, revoked: true, diagnostics: [] });
  assert.deepEqual(await check([r], 'historical', r.issuedAt), { ok: true, revoked: true, diagnostics: [] });
});

test('offline evidence applies only in explicitly present mode', async () => {
  const { attest: _, ...offline } = r;
  assert.deepEqual(await check([offline]), { ok: true, revoked: false, diagnostics: [{ index: 0, reason: 'bad-proof' }] });
  assert.deepEqual(await check([offline], 'present'), { ok: true, revoked: true, diagnostics: [] });
});

test('principal, target identity and link issuance window must match', async () => {
  for (const patch of [{ principal: keys[0].x + '.' + keys[0].y }, { linkId: '0'.repeat(64) }, { issuedAt: r.issuedAt + 1 }]) {
    const result = await checkForumLinkRevocations({ ...target, ...patch }, [r], r.principal, keys, r.issuedAt + 10000, 'historical');
    assert.deepEqual(result, { ok: true, revoked: false, diagnostics: [] });
  }
  assert.deepEqual(await check([r], 'historical', r.issuedAt - 1), { ok: true, revoked: false, diagnostics: [{ index: 0, reason: 'future-record' }] });
});

test('invalid entries are reported without hiding valid revocations', async () => {
  const result = await check([null, { ...r, keySig: 'forged' }, r]);
  assert.deepEqual(result, { ok: true, revoked: true, diagnostics: [{ index: 0, reason: 'bad-record' }, { index: 1, reason: 'bad-proof' }] });
  assert.ok(result.ok && Object.isFrozen(result.diagnostics));
  assert.deepEqual(await check([]), { ok: true, revoked: false, diagnostics: [] });
});

test('rejects oversized or invalid evaluation input without truncation', async () => {
  for (const rows of [null, {}, new Array(1025)]) assert.deepEqual(await check(rows), { ok: false, reason: 'bad-input' });
  for (const at of [-0, -1, NaN, Infinity, 1.5]) assert.deepEqual(await check([], 'historical', at), { ok: false, reason: 'bad-input' });
  assert.deepEqual(await checkForumLinkRevocations(target, [], 'bad', keys, r.issuedAt, 'historical'), { ok: false, reason: 'bad-input' });
});

test('snapshots every entry before async checks and never invokes list getters', async () => {
  const rows = [structuredClone(r), structuredClone(r)];
  const pending = check(rows);
  rows[1].keySig = 'changed';
  assert.deepEqual(await pending, { ok: true, revoked: true, diagnostics: [] });
  let reads = 0;
  const list = Object.defineProperty([null], '0', { get() { reads++; return r; } });
  assert.deepEqual(await check(list), { ok: true, revoked: false, diagnostics: [{ index: 0, reason: 'bad-record' }] });
  assert.equal(reads, 0);
});
