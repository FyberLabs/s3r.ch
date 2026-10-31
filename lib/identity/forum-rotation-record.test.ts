import assert from "node:assert/strict";
import test from "node:test";
import vectors from "./vectors/forum-rotation-record.json";
import { parseForumRotationRecord } from "./forum-rotation-record";
import { verifyForumKeySignature } from "./forum-key-signature";

const base = vectors.accept[0].input;
for (const vector of vectors.accept) {
  test(`rotation bytes match upstream: ${vector.name}`, () => {
    const parsed = parseForumRotationRecord(vector.input);
    assert.ok(parsed);
    assert.equal(Buffer.from(parsed.bytes).toString("hex"), vector.canonical);
    assert.equal(verifyForumKeySignature(parsed.record.nextKey, parsed.record.nextSig, parsed.bytes), true);
  });
}

test("signed rotation fields bind retained links, sequence and epub version", () => {
  for (const patch of [
    { seq: 2 }, { issuedAt: base.issuedAt + 1 }, { prevKey: base.nextKey },
    { principal: base.nextKey }, { nextKey: base.prevKey },
    { retainedLinks: [] }, { retainedLinks: ["0".repeat(64)] },
    { nextEpub: base.principal },
    { authorizer: { kind: "oidc-fresh-login", link: base.authorizer.link } },
    { authorizer: { ...base.authorizer, link: "0".repeat(64) } },
  ]) {
    const parsed = parseForumRotationRecord({ ...base, ...patch });
    assert.ok(parsed);
    assert.equal(verifyForumKeySignature(parsed.record.nextKey, parsed.record.nextSig, parsed.bytes), false);
  }
});

test("strict rotation shape rejects malformed and ambiguous fields", () => {
  const invalid = [
    null, [], {}, { ...base, extra: true }, { ...base, v: 2 }, { ...base, kind: "wallet" },
    ...[0, -0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(seq => ({ ...base, seq })),
    ...[-0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(issuedAt => ({ ...base, issuedAt })),
    ...[undefined, null, "", "invalid"].map(nextEpub => ({ ...base, nextEpub })),
    ...["principal", "prevKey", "nextKey"].map(field => ({ ...base, [field]: "invalid" })),
    ...[undefined, ["a".repeat(64), "a".repeat(64)], ["b".repeat(64), "a".repeat(64)], ["A".repeat(64)], new Array(1), new Array(1025)].map(retainedLinks => ({ ...base, retainedLinks })),
    { ...base, authorizer: { kind: "oidc-fresh-login", link: base.authorizer.link, siwe: {} } },
    { ...base, authorizer: { kind: "wallet", link: base.authorizer.link } },
    { ...base, authorizer: { ...base.authorizer, siwe: { message: "x", signature: "0x" } } },
    { ...base, authorizer: { ...base.authorizer, siwe: { message: "x".repeat(8193), signature: "0x" + "00".repeat(65) } } },
    ...["", "x".repeat(129), " x", "x\u200b", "x\ud800", "get(x)"].map(nextSig => ({ ...base, nextSig })),
    { ...base, attest: "x".repeat(16385) },
  ];
  for (const input of invalid) assert.equal(parseForumRotationRecord(input), null);
});

test("nested inputs are detached and frozen; accessors and revoked proxies fail closed", () => {
  const input = structuredClone(base);
  const parsed = parseForumRotationRecord(input);
  assert.ok(parsed);
  input.retainedLinks.length = 0;
  input.authorizer.link = "0".repeat(64);
  input.authorizer.siwe!.message = "changed";
  assert.deepEqual(parsed.record, base);
  assert.ok(Object.isFrozen(parsed.record));
  assert.ok(Object.isFrozen(parsed.record.authorizer));
  assert.ok(Object.isFrozen(parsed.record.retainedLinks));
  if (parsed.record.authorizer.kind === "wallet") assert.ok(Object.isFrozen(parsed.record.authorizer.siwe));
  let reads = 0;
  const getter = { get value() { reads++; throw new Error("getter invoked"); } };
  const descriptor = Object.getOwnPropertyDescriptor(getter, "value")!;
  for (const input of [
    Object.defineProperty({ ...base }, "seq", descriptor),
    { ...base, authorizer: Object.defineProperty({ ...base.authorizer }, "link", descriptor) },
    { ...base, retainedLinks: Object.defineProperty([base.authorizer.link], "0", descriptor) },
    { ...base, authorizer: { ...base.authorizer, siwe: Object.defineProperty({}, "message", descriptor) } },
  ]) assert.equal(parseForumRotationRecord(input), null);
  assert.equal(reads, 0);
  const proxy = Proxy.revocable({}, {}); proxy.revoke();
  assert.equal(parseForumRotationRecord(proxy.proxy), null);
  assert.equal(parseForumRotationRecord({ ...base, retainedLinks: proxy.proxy }), null);
  assert.equal(parseForumRotationRecord(Object.create(base)), null);
});

test("parsing and next-key signature do not authenticate recovery evidence", () => {
  const parsed = parseForumRotationRecord({ ...base, attest: "forged", authorizer: {
    ...base.authorizer, siwe: { message: "", signature: "0x" + "00".repeat(65) },
  } });
  assert.ok(parsed);
  assert.equal(verifyForumKeySignature(parsed.record.nextKey, parsed.record.nextSig, parsed.bytes), true);
  // These unsigned proofs require independent validation; no authority is returned.
  assert.equal("currentKey" in parsed, false);
});

test("transport bounds include empty and 1024 retained-link commitments", () => {
  for (const size of [0, 1024]) {
    const retainedLinks = Array.from({ length: size }, (_, i) => i.toString(16).padStart(64, "0"));
    assert.ok(parseForumRotationRecord({ ...base, retainedLinks, issuedAt: 0, attest: "x".repeat(16384),
      authorizer: { ...base.authorizer, siwe: { message: "x".repeat(8192), signature: "0x" + "00".repeat(65) } },
    }));
  }
});
