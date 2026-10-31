import assert from "node:assert/strict";
import { test } from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createForumKeyResolver, type AuthenticatedForumHistory } from "./forum-history-adapter";
import { createForumObjectStore } from "./forum-object-store";
import vectors from "./vectors/forum-object-record.json";
import principals from "./vectors/principal.json";
const owner = principals.accept[0].input;
const next = principals.accept[1].input;
const point = p256.Point.BASE.multiply(3n).toBytes(false);
const third = `${Buffer.from(point.slice(1,33)).toString('base64url')}.${Buffer.from(point.slice(33)).toString('base64url')}`;
const rotation = { seq: 1, prevKey: owner, nextKey: next, issuedAt: 100 };

test('key selection respects rotation boundaries and multiple transitions', () => {
  const resolve = createForumKeyResolver((owner, now) => ({ owner, evaluatedAt: now, rotations: [rotation,
    { seq: 2, prevKey: next, nextKey: third, issuedAt: 200 }] }));
  for (const [at, expected] of [[99,owner],[100,owner],[101,next],[200,next],[201,third]] as const) {
    assert.deepEqual(resolve(owner, at, 300), { owner, issuedAt: at, now: 300, keyAtIssuedAt: expected, currentKey: third });
  }
});

test('missing, stale, mismatched, throwing and invalid histories deny', () => {
  assert.equal(createForumKeyResolver(null)(owner, 100, 100), null);
  assert.equal(createForumKeyResolver(() => { throw new Error('offline'); })(owner, 100, 100), null);
  const invalid: AuthenticatedForumHistory[] = [
    { owner: next, evaluatedAt: 300, rotations: [] },
    { owner, evaluatedAt: 299, rotations: [] },
    ...[
      [{ ...rotation, seq: 2 }], [{ ...rotation, prevKey: next }],
      [{ ...rotation, nextKey: owner }], [{ ...rotation, issuedAt: 301 }],
      [{ ...rotation, issuedAt: NaN }], [rotation, rotation],
      [rotation, { seq: 2, prevKey: next, nextKey: third, issuedAt: 100 }],
      Array.from({ length: 1025 }, () => rotation),
    ].map(rotations => ({ owner, evaluatedAt: 300, rotations })),
  ];
  for (const history of invalid) assert.equal(createForumKeyResolver(() => history)(owner, 100, 300), null);
});

test('store reads refresh provider authority and do not reuse old history', () => {
  const row = vectors.accept.find(v => v.signatureValidUnderOwner)!.record;
  let history: AuthenticatedForumHistory | null = { owner, evaluatedAt: row.issuedAt, rotations: [] };
  const store = createForumObjectStore(createForumKeyResolver(() => history));
  assert.equal(store.admit(row, row.issuedAt).ok, true);
  assert.equal(store.ownerOf(row.object, row.issuedAt), owner);
  history = null;
  assert.equal(store.ownerOf(row.object, row.issuedAt), undefined);
  history = { owner, evaluatedAt: row.issuedAt + 1, rotations: [{ ...rotation, issuedAt: row.issuedAt + 1 }] };
  assert.equal(store.ownerOf(row.object, row.issuedAt + 1), undefined);
});
