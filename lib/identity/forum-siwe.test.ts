import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import vectors from "./vectors/forum-rotation-record.json";
import { parseForumRotationRecord } from "./forum-rotation-record";
import { verifyForumSiwe } from "./forum-siwe";
const base = vectors.accept[0].input;
const proof = base.authorizer.siwe!;
const bytes = parseForumRotationRecord(base)!.bytes;
const address = proof.message.split('\n')[1];
const policy = { allowedDomains: ['s3r.ch'], allowedUris: ['https://s3r.ch/identity/link'], allowedChainIds: ['1'] };
const account = privateKeyToAccount(('0x' + '0'.repeat(63) + '4') as `0x${string}`);
const verify = (message: string, signature: string, now = base.issuedAt) => verifyForumSiwe(address, message, signature, bytes, base.issuedAt, now, policy);
async function signed(message: string, now = base.issuedAt) { return verify(message, await account.signMessage({ message }), now); }

test('upstream SIWE proofs bind exact rotation signing bytes', async () => {
  for (const v of vectors.accept) {
    const p = v.input.authorizer.siwe!;
    assert.equal(await verifyForumSiwe(address, p.message, p.signature, parseForumRotationRecord(v.input)!.bytes, v.input.issuedAt, v.input.issuedAt, policy), v.name !== 'damaged-rotation-proof-same-id');
  }
  assert.equal(await verifyForumSiwe(address, proof.message, proof.signature, new Uint8Array([1]), base.issuedAt, base.issuedAt, policy), false);
  assert.ok(await verifyForumSiwe(address, proof.message, proof.signature, bytes, base.issuedAt, base.issuedAt, policy, 'rotation1234'));
  assert.equal(await verifyForumSiwe(address, proof.message, proof.signature, bytes, base.issuedAt, base.issuedAt, policy, 'wrongnonce'), false);
});

test('valid signatures cannot bypass policy or exact SIWE grammar', async () => {
  for (const message of [
    proof.message.replace('s3r.ch wants', 'attacker.com wants'),
    proof.message.replace('URI: https://s3r.ch/identity/link', 'URI: https://s3r.ch/other'),
    proof.message.replace('Chain ID: 1', 'Chain ID: 2'),
    proof.message.replace('Version: 1', 'Version: 2'),
    proof.message.replace('Nonce: rotation1234', 'Nonce: short'),
    proof.message.replace('SociACL link:', 'Sign in:'),
    proof.message.replace('2023-11-14T22:13:50Z', '2023-02-30T22:13:50Z'),
    proof.message.replace('2023-11-14T22:13:50Z', '2023-11-14T22:13:51Z'),
    proof.message.replaceAll('\n', '\r\n'), proof.message + '\n',
    proof.message + '\nResources:\n- http://s3r.ch/file',
    proof.message + '\nRequest ID: bad%xx',
  ]) assert.equal(await signed(message), false, message);
});

test('optional fields have strict ordering, dates and expiry boundaries', async () => {
  const message = proof.message + '\nExpiration Time: 2023-11-14T22:14:50Z\nNot Before: 2023-11-14T22:13:50Z\nRequest ID: request%20id\nResources:\n- https://s3r.ch/file';
  assert.ok(await signed(message));
  assert.equal(await signed(message, base.issuedAt + 60), false);
  assert.ok(await signed(message, base.issuedAt + 59));
  assert.equal(await signed(message.replace('Not Before: 2023-11-14T22:13:50Z', 'Not Before: 2023-11-14T22:13:51Z')), false);
  assert.ok(await signed(proof.message.replace('2023-11-14T22:13:50Z', '2023-11-14T23:13:50+01:00')));
});

test('explicit allowlists cannot admit unsafe or normalized URI spellings', async () => {
  for (const uri of ['http://s3r.ch/path', 'https://localhost/path', 'https://xn--abc.com/path', 'https://s3r.ch:443/path', 'https://s3r.ch/a/../b', 'https://s3r.ch/%61', 'https://s3r.ch/path?query=1']) {
    const message = proof.message.replace('https://s3r.ch/identity/link', uri);
    assert.equal(await verifyForumSiwe(address, message, await account.signMessage({ message }), bytes, base.issuedAt, base.issuedAt, { ...policy, allowedUris: [uri] }), false, uri);
  }
});

test('invalid clocks deny and policy/bytes are snapshotted before hashing', async () => {
  for (const now of [NaN, Infinity, -0, -1, 1.5, base.issuedAt - 1]) assert.equal(await verify(proof.message, proof.signature, now), false);
  const mutable = structuredClone(policy), copy = bytes.slice();
  const pending = verifyForumSiwe(address, proof.message, proof.signature, copy, base.issuedAt, base.issuedAt, mutable);
  copy.fill(0); mutable.allowedDomains.length = 0;
  assert.ok(await pending);
});
