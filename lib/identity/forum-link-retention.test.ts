import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createForumLinkKeyResolver, type AuthenticatedForumLinkHistory } from "./forum-link-retention";
const key = (n: number) => { const p = p256.Point.BASE.multiply(BigInt(n)).toBytes(false); return Buffer.from(p.slice(1,33)).toString('base64url') + '.' + Buffer.from(p.slice(33)).toString('base64url'); };
const [genesis, second, third, fourth] = [1,2,3,4].map(key);
const [a,b,c] = ['a','b','c'].map(s => s.repeat(64));
const history = (): AuthenticatedForumLinkHistory => ({ owner: genesis, evaluatedAt: 300, rotations: [
  { seq: 1, prevKey: genesis, nextKey: second, issuedAt: 100, retainedLinks: [a,b] },
  { seq: 2, prevKey: second, nextKey: third, issuedAt: 200, retainedLinks: [b,c] },
  { seq: 3, prevKey: third, nextKey: fourth, issuedAt: 300, retainedLinks: [a,b,c] },
] });

test('every applicable rotation must retain a link; later lists cannot restore it', () => {
  const resolve = createForumLinkKeyResolver(history);
  for (const at of [0,99,100]) {
    const state = resolve(genesis, at, 300)!;
    assert.equal(state.keyAtIssuedAt, genesis); assert.equal(state.currentKey, fourth);
    assert.deepEqual(state.retainedLinks, [b]);
  }
  for (const at of [101,199,200]) {
    const state = resolve(genesis, at, 300)!;
    assert.equal(state.keyAtIssuedAt, second); assert.deepEqual(state.retainedLinks, [b,c]);
  }
  assert.deepEqual(resolve(genesis, 300, 300)!.retainedLinks, [a,b,c]);
});

test('distinguishes no applicable rotation from an explicit empty commitment', () => {
  assert.equal(createForumLinkKeyResolver(() => ({ owner: genesis, evaluatedAt: 10, rotations: [] }))(genesis, 5, 10)!.retainedLinks, null);
  const h = history();
  const resolve = createForumLinkKeyResolver(() => ({ ...h, evaluatedAt: 301 }));
  assert.equal(resolve(genesis, 301, 301)!.retainedLinks, null);
  assert.deepEqual(createForumLinkKeyResolver(() => ({ ...h, rotations: h.rotations.map((r,i) => i === 1 ? { ...r, retainedLinks: [] } : r) }))(genesis, 50, 300)!.retainedLinks, []);
});

test('malformed commitments, discontinuous chains and unavailable history deny', () => {
  const h = history();
  for (const retainedLinks of [undefined, [b,a], [a,a], ['A'.repeat(64)], new Array(1), new Array(1025)]) {
    const input = { ...h, rotations: [{ ...h.rotations[0], retainedLinks }, ...h.rotations.slice(1)] } as unknown as AuthenticatedForumLinkHistory;
    assert.equal(createForumLinkKeyResolver(() => input)(genesis, 50, 300), null);
  }
  assert.equal(createForumLinkKeyResolver(() => ({ ...h, rotations: h.rotations.slice(1) }))(genesis, 50, 300), null);
  assert.equal(createForumLinkKeyResolver(null)(genesis, 50, 300), null);
  assert.equal(createForumLinkKeyResolver(() => { throw Error('offline'); })(genesis, 50, 300), null);
  assert.equal(createForumLinkKeyResolver(history)(genesis, 301, 300), null);
  assert.equal(createForumLinkKeyResolver(history)(genesis, 50, 301), null);
});

test('results detach from provider state and history is refreshed on every lookup', () => {
  const h = structuredClone(history()); let calls = 0; let available = true;
  const resolve = createForumLinkKeyResolver(() => { calls++; return available ? h : null; });
  const result = resolve(genesis, 50, 300)!;
  (h.rotations[0].retainedLinks as string[]).length = 0;
  assert.deepEqual(result.retainedLinks, [b]); assert.ok(Object.isFrozen(result.retainedLinks));
  assert.deepEqual(resolve(genesis, 50, 300)!.retainedLinks, []);
  available = false; assert.equal(resolve(genesis, 50, 300), null); assert.equal(calls, 3);
});
