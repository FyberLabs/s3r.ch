import assert from "node:assert/strict";
import test from "node:test";
import vectors from "./vectors/forum-rotation-record.json";
import { parseForumRotationCandidate, parseForumRotationRecord } from "./forum-rotation-record";
import { verifyForumKeySignature } from "./forum-key-signature";

const base = vectors.accept[0].input;

test("missing and malformed wallet proofs preserve signed v2/v3 identities", () => {
  for (const vector of vectors.accept) {
    for (const siwe of [undefined, null, {}, [], "garbage", { message: "x", signature: "0x" },
      { message: "x".repeat(8193), signature: "0x" + "00".repeat(65) }]) {
      const input = { ...vector.input, authorizer: { ...vector.input.authorizer, siwe } };
      assert.equal(parseForumRotationRecord(input), null);
      const candidate = parseForumRotationCandidate(input);
      assert.ok(candidate);
      assert.equal(candidate.recoveryProof, "malformed");
      assert.equal(Buffer.from(candidate.bytes).toString("hex"), vector.canonical);
      assert.equal(candidate.record.nextSig, vector.input.nextSig);
      assert.equal(candidate.record.attest, vector.input.attest);
      assert.equal(verifyForumKeySignature(candidate.record.nextKey, candidate.record.nextSig, candidate.bytes), true);
      assert.equal(candidate.record.authorizer.kind, "wallet");
      if (candidate.record.authorizer.kind === "wallet") {
        assert.deepEqual(candidate.record.authorizer.siwe, { message: "", signature: "0x" + "00".repeat(65) });
      }
    }
  }
});

test("present recovery proofs remain explicitly unverified, including damaged-but-well-shaped proof", () => {
  for (const vector of vectors.accept) {
    const candidate = parseForumRotationCandidate(vector.input);
    assert.ok(candidate);
    assert.equal(candidate.recoveryProof, "unverified");
    assert.deepEqual(candidate.record, parseForumRotationRecord(vector.input)!.record);
  }
  const candidate = parseForumRotationCandidate({ ...base, authorizer: { kind: "oidc-fresh-login", link: base.authorizer.link } });
  assert.equal(candidate?.recoveryProof, "unverified");
});

test("fallback never repairs signed fields or missing timestamp/signature evidence", () => {
  for (const patch of [
    { v: 2 }, { principal: "invalid" }, { seq: 0 }, { issuedAt: -1 },
    { prevKey: "invalid" }, { nextKey: "invalid" }, { nextEpub: undefined },
    { nextSig: undefined }, { attest: undefined }, { retainedLinks: undefined },
    { retainedLinks: ["a".repeat(64), "a".repeat(64)] }, { extra: true },
  ]) assert.equal(parseForumRotationCandidate({ ...base, ...patch, authorizer: { ...base.authorizer, siwe: null } }), null);
  for (const authorizer of [null, {}, { kind: "wallet", link: "invalid" },
    { kind: "wallet", link: base.authorizer.link, extra: true },
    { kind: "oidc-fresh-login", link: base.authorizer.link, siwe: null }]) {
    assert.equal(parseForumRotationCandidate({ ...base, authorizer }), null);
  }
  const candidate = parseForumRotationCandidate({ ...base, seq: 2, authorizer: { ...base.authorizer, siwe: null } });
  assert.ok(candidate);
  assert.equal(verifyForumKeySignature(candidate.record.nextKey, candidate.record.nextSig, candidate.bytes), false);
});

test("candidate snapshots cannot invoke accessors or retain mutable evidence", () => {
  let reads = 0;
  const proof = Object.defineProperty({}, "message", { get() { reads++; throw new Error("called"); } });
  const input = structuredClone(base);
  const candidate = parseForumRotationCandidate(input)!;
  input.authorizer.link = "0".repeat(64);
  input.retainedLinks.length = 0;
  assert.deepEqual(candidate.record, base);
  assert.ok(Object.isFrozen(candidate));
  assert.equal(parseForumRotationCandidate({ ...base, authorizer: { ...base.authorizer, siwe: proof } })?.recoveryProof, "malformed");
  const a = Object.defineProperty({ ...base.authorizer }, "siwe", { get() { reads++; return proof; } });
  assert.equal(parseForumRotationCandidate({ ...base, authorizer: a }), null);
  const proxy = Proxy.revocable({}, {}); proxy.revoke();
  assert.equal(parseForumRotationCandidate(proxy.proxy), null);
  assert.equal(reads, 0);
});
