import assert from "node:assert/strict";
import test from "node:test";
import wallet from "./vectors/forum-wallet-link.json";
import witnesses from "./vectors/forum-witness.json";
import revoke from "./vectors/forum-revoke.json";
import { resolveForumWalletRecoveryLink } from "./forum-wallet-link-resolution";
import type { ForumRecoveryProvider } from "./forum-wallet-eligibility";
import type { ForumWitnessKey } from "./forum-witness-verification";
const link = wallet.wallet.input;
const keys = witnesses.keys as ForumWitnessKey[];
const policy = { allowedDomains: ['s3r.ch'], allowedUris: ['https://s3r.ch/identity/link'], allowedChainIds: ['1'] };
const provider: ForumRecoveryProvider = (owner, at) => ({ history: { owner, evaluatedAt: at, rotations: [] }, revocations: [] });
const resolve = (rows: unknown, p = provider) => resolveForumWalletRecoveryLink(link.address, rows, p, keys, policy, link.issuedAt + 10000, 'historical');

test('duplicate copies deduplicate by signed link identity and damaged copies do not hide valid ones', async () => {
  const result = await resolve([link, { ...link, keySig: 'forged' }, structuredClone(link)]);
  assert.ok(result.ok); assert.equal(result.link.linkId, wallet.wallet.linkId);
  assert.deepEqual(result.diagnostics, [{ index: 1, reason: 'bad-proof' }]);
});

test('revoked, invalid and unrelated candidates cannot become selected', async () => {
  const revoked: ForumRecoveryProvider = (owner, at) => ({ history: { owner, evaluatedAt: at, rotations: [] }, revocations: [revoke.revoke.input] });
  const result = await resolve([null, link], revoked);
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.reason, 'unknown-link');
  const unrelated = await resolve([{ ...link, address: '0x' + '00'.repeat(20) }]);
  assert.equal(unrelated.ok, false);
});

test('missing history is fatal and oversized inputs are not truncated', async () => {
  const missing = await resolve([link], () => null);
  assert.equal(missing.ok, false); if (!missing.ok) assert.equal(missing.reason, 'missing-history');
  for (const input of [null, {}, new Array(1025)]) {
    const result = await resolve(input); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.reason, 'bad-input');
  }
});

test('list/record snapshots resist edits while verification is pending', async () => {
  const rows = [structuredClone(link)]; const pending = resolve(rows);
  rows[0].keySig = 'mutated'; rows.length = 0;
  assert.ok((await pending).ok);
  let reads = 0;
  const result = await resolve(Object.defineProperty([null], '0', { get() { reads++; return link; } }));
  assert.equal(reads, 0); assert.equal(result.ok, false);
});

test('newest eligible link wins and distinct links at the same time are ambiguous', async () => {
  const { p256 } = await import('@noble/curves/nist.js');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { createHash } = await import('node:crypto');
  const { parseForumWalletLinkRecord } = await import('./forum-wallet-link-record');
  const account = privateKeyToAccount(('0x' + '0'.repeat(63) + '4') as `0x${string}`);
  const secret = new Uint8Array(32); secret[31] = 1;
  const witnessSecret = new Uint8Array(32); witnessSecret[31] = 7;
  const pub = p256.getPublicKey(witnessSecret, false);
  const b64 = (v: string | Uint8Array) => Buffer.from(v).toString('base64url');
  const trust: ForumWitnessKey = { kid: 'test', kty: 'EC', crv: 'P-256', x: b64(pub.slice(1,33)), y: b64(pub.slice(33)), notBefore: 0, notAfter: Number.MAX_SAFE_INTEGER };
  async function mint(nonce: string, issuedAt: number, scalar = 1) {
    const row = structuredClone(link); row.nonce = nonce; row.issuedAt = issuedAt;
    const signingSecret = secret.slice(); signingSecret[31] = scalar;
    const identity = p256.getPublicKey(signingSecret, false);
    row.principal = b64(identity.slice(1,33)) + '.' + b64(identity.slice(33));
    const bytes = parseForumWalletLinkRecord(row)!.bytes;
    const id = createHash('sha256').update(bytes).digest('hex');
    row.keySig = b64(p256.sign(bytes, signingSecret, { prehash: true, format: 'compact' }));
    row.siwe.message = link.siwe.message.replace(wallet.wallet.linkId, id).replace(link.nonce, nonce).replace('2023-11-14T22:13:20Z', new Date(issuedAt * 1000).toISOString().replace('.000Z','Z'));
    row.siwe.signature = await account.signMessage({ message: row.siwe.message });
    const msg = b64(JSON.stringify({ alg: 'ES256', kid: 'test' })) + '.' + b64(JSON.stringify({ typ: 'sociacl-wallet-attest-v1', principal: row.principal, linkId: id, iat: issuedAt, exp: issuedAt + 600 }));
    row.attest = msg + '.' + b64(p256.sign(new TextEncoder().encode(msg), witnessSecret, { prehash: true, format: 'compact' }));
    return row;
  }
  const newer = await mint('newerNonce123', link.issuedAt + 1);
  const sibling = await mint('siblingNonce123', newer.issuedAt);
  const run = (rows: unknown[]) => resolveForumWalletRecoveryLink(link.address, rows, provider, [...keys, trust], policy, newer.issuedAt + 1000, 'historical');
  for (const rows of [[link, newer], [newer, link]]) {
    const result = await run(rows); assert.ok(result.ok); assert.equal(result.link.record.nonce, newer.nonce);
  }
  const ambiguous = await run([link, newer, sibling]);
  assert.equal(ambiguous.ok, false); if (!ambiguous.ok) assert.equal(ambiguous.reason, 'ambiguous-link');
  const foreign = await mint('foreignNonce123', newer.issuedAt + 1, 2);
  const selective: ForumRecoveryProvider = (owner, at) => owner === link.principal ? provider(owner, at) : null;
  const missing = await resolveForumWalletRecoveryLink(link.address, [link, foreign], selective, [...keys, trust], policy, newer.issuedAt + 1000, 'historical');
  assert.equal(missing.ok, false); if (!missing.ok) assert.equal(missing.reason, 'missing-history');
});

test('forged unknown-principal candidates cannot make missing history fatal', async () => {
  const foreign = keys[0].x + '.' + keys[0].y;
  const fake = { ...link, principal: foreign, keySig: 'dummy', attest: 'dummy', siwe: { message: '', signature: '0x' + '00'.repeat(65) } };
  for (const rows of [[fake, link], [link, fake], [{ ...link, principal: foreign }, link]]) {
    const requested: string[] = [];
    const p: ForumRecoveryProvider = (owner, at) => { requested.push(owner); return owner === link.principal ? provider(owner, at) : null; };
    const result = await resolve(rows, p);
    assert.ok(result.ok); assert.equal(result.link.linkId, wallet.wallet.linkId);
    assert.deepEqual(requested, [link.principal]);
    assert.ok(result.diagnostics.some(d => d.reason === 'bad-proof'));
  }
});
