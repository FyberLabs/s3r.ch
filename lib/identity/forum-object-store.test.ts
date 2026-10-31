import assert from "node:assert/strict";
import { test } from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createForumObjectStore } from "./forum-object-store";
import { parseForumObjectRecord } from "./forum-object-record";
import type { ForumKeyResolver } from "./forum-object-verification";
import principals from "./vectors/principal.json";

const owner = principals.accept[0].input;
const rotated = principals.accept[1].input;
const object = `status_${principals.accept[0].pathKey}_${'ab'.repeat(16)}`;
function signed(issuedAt: number, scalar = 1) {
  const record = { object, owner, issuedAt, sig: 'placeholder' };
  const bytes = parseForumObjectRecord(record)!.bytes;
  const secret = new Uint8Array(32); secret[31] = scalar;
  return { ...record, sig: Buffer.from(p256.sign(bytes, secret, { prehash: true })).toString('base64url') };
}
function authority() {
  let available = true;
  let rotation = Infinity;
  const resolve: ForumKeyResolver = (principal, at, now) => available ? {
    owner: principal, issuedAt: at, now,
    keyAtIssuedAt: at > rotation ? rotated : owner,
    currentKey: now >= rotation ? rotated : owner,
  } : null;
  return { resolve, unavailable() { available = false; }, available() { available = true; }, rotate(at: number) { rotation = at; } };
}

test('only verified signed records can establish ownership', () => {
  const auth = authority(); const store = createForumObjectStore(auth.resolve);
  assert.equal(store.ownerOf(object, 100), undefined);
  assert.equal(store.admit({ object, owner }, 100).ok, false);
  assert.equal(store.admit({ ...signed(10), sig: 'forged' }, 100).ok, false);
  const input = signed(10);
  assert.deepEqual(store.admit(input, 100), { ok: true, kept: true });
  input.owner = rotated; input.sig = 'changed';
  assert.equal(store.ownerOf(object, 100), owner);
  assert.equal(store.ownerOf(object, NaN), undefined);
});

test('history loss hides authority and recovery rechecks the retained record', () => {
  const auth = authority(); const store = createForumObjectStore(auth.resolve);
  store.admit(signed(10), 100);
  auth.unavailable();
  assert.equal(store.ownerOf(object, 100), undefined);
  assert.deepEqual(store.admit(signed(11), 100), { ok: false, reason: 'missing-history' });
  auth.available();
  assert.equal(store.ownerOf(object, 100), owner);
  assert.deepEqual(createForumObjectStore(null).admit(signed(10), 100), { ok: false, reason: 'missing-history' });
});

test('rotation requires a newer current-key record and cannot rewrite genesis ownership', () => {
  const auth = authority(); const store = createForumObjectStore(auth.resolve);
  assert.deepEqual(store.admit(signed(10), 100), { ok: true, kept: true });
  assert.deepEqual(store.admit(signed(11), 100), { ok: true, kept: false });
  auth.rotate(150);
  assert.equal(store.ownerOf(object, 150), undefined);
  assert.equal(store.admit(signed(151), 160).ok, false);
  assert.equal(store.admit(signed(150, 2), 160).ok, false); // rotation boundary is pre-rotation
  assert.deepEqual(store.admit(signed(151, 2), 160), { ok: true, kept: true });
  assert.equal(store.ownerOf(object, 160), owner);
  assert.equal(store.admit(signed(10), 160).ok, false);
  assert.deepEqual(store.admit(signed(151, 2), 160), { ok: true, kept: false });
  assert.equal(store.ownerOf(object, 160), owner);
});
