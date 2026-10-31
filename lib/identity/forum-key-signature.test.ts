import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyForumKeySignature } from "./forum-key-signature";
import { parseForumObjectRecord } from "./forum-object-record";
import vectors from "./vectors/forum-object-record.json";
import principals from "./vectors/principal.json";

for (const [index, vector] of vectors.accept.entries()) {
  test(`object signature matches upstream key verification ${index}`, () => {
    const parsed = parseForumObjectRecord(vector.record)!;
    assert.equal(verifyForumKeySignature(vector.record.owner, vector.record.sig, parsed.bytes), vector.signatureValidUnderOwner);
  });
}
const vector = vectors.accept.find(row => row.signatureValidUnderOwner)!;
const bytes = new Uint8Array(Buffer.from(vector.hex, "hex"));
const { owner, sig } = vector.record;

test("key, signing domain, timestamp and object substitutions fail", () => {
  assert.equal(verifyForumKeySignature(principals.accept[1].input, sig, bytes), false);
  const changed = bytes.slice(); changed[4] ^= 1;
  assert.equal(verifyForumKeySignature(owner, sig, changed), false);
  for (const patch of [{ issuedAt: vector.record.issuedAt + 1 }, { object: vector.record.object.slice(0, -1) + '2' }]) {
    const parsed = parseForumObjectRecord({ ...vector.record, ...patch })!;
    assert.ok(parsed);
    assert.equal(verifyForumKeySignature(owner, sig, parsed.bytes), false);
  }
  assert.equal(verifyForumKeySignature(owner, sig, bytes), true);
});

test("canonical compact signatures accept both high-S and low-S", () => {
  const raw = Buffer.from(sig, "base64url");
  const order = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const s = BigInt('0x' + raw.subarray(32).toString('hex'));
  const alternate = Buffer.concat([raw.subarray(0, 32), Buffer.from((order - s).toString(16).padStart(64, '0'), 'hex')]);
  assert.equal(verifyForumKeySignature(owner, alternate.toString('base64url'), bytes), true);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias = sig.slice(0, -1) + alphabet[alphabet.indexOf(sig.at(-1)!) + 1];
  assert.deepEqual(Buffer.from(alias, 'base64url'), raw);
  assert.equal(verifyForumKeySignature(owner, alias, bytes), false);
});

test("malformed signatures, keys and byte inputs fail closed", () => {
  for (const invalid of [undefined, null, {}, '', sig + '=', sig.slice(1), 'A'.repeat(86), 'SEA' + sig, sig.replace(/./, '+')]) {
    assert.equal(verifyForumKeySignature(owner, invalid, bytes), false);
  }
  for (const invalid of [undefined, null, {}, 'wallet', 'A'.repeat(43) + '.' + 'A'.repeat(43)]) {
    assert.equal(verifyForumKeySignature(invalid, sig, bytes), false);
  }
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const invalid of [undefined, null, {}, [], bytes.buffer, revoked.proxy]) {
    assert.equal(verifyForumKeySignature(owner, sig, invalid), false);
  }
});
