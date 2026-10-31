import assert from "node:assert/strict";
import { test } from "node:test";
import { parseForumObjectRecord } from "./forum-object-record";
import vectors from "./vectors/forum-object-record.json";
import principals from "./vectors/principal.json";

for (const [index, vector] of vectors.accept.entries()) {
  test(`object signing bytes match upstream fixture ${index}`, () => {
    const parsed = parseForumObjectRecord(vector.record);
    assert.ok(parsed);
    assert.deepEqual(parsed.record, vector.record);
    assert.equal(Buffer.from(parsed.bytes).toString("hex"), vector.hex);
    assert.equal(Object.isFrozen(parsed.record), true);
  });
}
const valid = vectors.accept[0].record;
test("object records reject wrong owners, noncanonical ids, domains, and clocks", () => {
  for (const patch of [
    { owner: principals.accept[1].input }, { owner: "wallet" },
    { object: valid.object.toUpperCase() }, { object: "claim_" + "a".repeat(64) },
    { object: valid.object.replace(/^chat_/, "post_") },
    { object: valid.object.replace(/^chat_/, "x_") },
    { domain: "sociacl-see-grant-v2" },
    ...[NaN, Infinity, -Infinity, -0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"].map(issuedAt => ({ issuedAt })),
    ...[undefined, null, "", "x".repeat(129), " sig", "sig\n", "get(x)", "\ud800"].map(sig => ({ sig })),
  ]) assert.equal(parseForumObjectRecord({ ...valid, ...patch }), null, JSON.stringify(patch));
  assert.ok(parseForumObjectRecord({ ...valid, domain: "sociacl-object-v2", issuedAt: 0 }));
  assert.ok(parseForumObjectRecord({ ...valid, issuedAt: Number.MAX_SAFE_INTEGER }));
});

test("object parsing neither reads inherited fields nor invokes accessors", () => {
  assert.equal(parseForumObjectRecord(Object.create(valid)), null);
  let reads = 0;
  const getter = { ...valid, get sig() { reads++; return valid.sig; } };
  assert.equal(parseForumObjectRecord(getter), null);
  assert.equal(reads, 0);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.equal(parseForumObjectRecord(revoked.proxy), null);
  for (const value of [null, [], true, 3, "record"]) assert.equal(parseForumObjectRecord(value), null);
});

test("object snapshots are detached and parsing does not verify signatures", () => {
  const input = { ...valid, sig: "not-a-valid-signature" };
  const parsed = parseForumObjectRecord(input)!;
  assert.ok(parsed); // Shape parsing deliberately cannot confer ownership.
  input.owner = principals.accept[1].input;
  input.issuedAt++;
  assert.equal(parsed.record.owner, valid.owner);
  assert.equal(parsed.record.issuedAt, valid.issuedAt);
  const another = parseForumObjectRecord(valid)!;
  parsed.bytes.fill(0);
  assert.equal(Buffer.from(another.bytes).toString("hex"), vectors.accept[0].hex);
});
