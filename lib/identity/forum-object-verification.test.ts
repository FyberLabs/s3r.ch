import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyForumObjectRecord, type ForumKeyResolver } from "./forum-object-verification";
import vectors from "./vectors/forum-object-record.json";
import principals from "./vectors/principal.json";
const vector = vectors.accept.find(row => row.signatureValidUnderOwner)!;
const row = vector.record;
const now = row.issuedAt;
// Test adapter only; no application resolver is provided by this module.
const genesis: ForumKeyResolver = (owner, issuedAt, now) => ({ owner, issuedAt, now, keyAtIssuedAt: owner, currentKey: owner });
const nextKey = principals.accept[1].input;

test("object verification requires fresh, account-bound resolution on every call", () => {
  let calls = 0;
  let retired = false;
  const resolve: ForumKeyResolver = (...args) => {
    calls++;
    const state = genesis(...args)!;
    return retired ? { ...state, currentKey: nextKey } : state;
  };
  assert.equal(verifyForumObjectRecord(row, resolve, now).ok, true);
  retired = true;
  assert.deepEqual(verifyForumObjectRecord(row, resolve, now), { ok: false, reason: 'retired-key' });
  assert.equal(calls, 2);
  assert.deepEqual(verifyForumObjectRecord(row, null, now), { ok: false, reason: 'missing-history' });
});

test("resolver failure, missing history, wrong account or time deny", () => {
  for (const resolve of [
    () => null,
    () => { throw new Error('fork or unavailable'); },
    () => ({ ...genesis(row.owner, now, now)!, owner: nextKey }),
    () => ({ ...genesis(row.owner, now, now)!, issuedAt: now - 1 }),
    () => ({ ...genesis(row.owner, now, now)!, now: now - 1 }),
    () => ({ ...genesis(row.owner, now, now)!, currentKey: 'invalid' }),
  ]) assert.deepEqual(verifyForumObjectRecord(row, resolve, now), { ok: false, reason: 'missing-history' });
});

test("issuance policy rejects invalid clocks and enforces the skew boundary", () => {
  const mustNotResolve = () => { assert.fail('invalid time reached resolver'); };
  for (const time of [NaN, Infinity, -1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(verifyForumObjectRecord(row, mustNotResolve, time), { ok: false, reason: 'bad-record' });
  }
  for (const skew of [-1, -0, 0.5, 301, Infinity]) {
    assert.deepEqual(verifyForumObjectRecord(row, mustNotResolve, now, skew), { ok: false, reason: 'bad-record' });
  }
  assert.deepEqual(verifyForumObjectRecord(row, mustNotResolve, now - 301, 300), { ok: false, reason: 'future-record' });
  assert.equal(verifyForumObjectRecord(row, genesis, now - 300, 300).ok, true);
  assert.equal(verifyForumObjectRecord(row, genesis, Number.MAX_SAFE_INTEGER, 300).ok, true);
});

test("trusted resolution does not bypass signature verification or input snapshots", () => {
  assert.deepEqual(verifyForumObjectRecord({ ...row, sig: 'fake' }, genesis, now), { ok: false, reason: 'bad-signature' });
  const input = { ...row };
  const result = verifyForumObjectRecord(input, (...args) => {
    input.sig = 'mutated'; input.issuedAt++;
    return genesis(...args);
  }, now);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.record, row);
});
