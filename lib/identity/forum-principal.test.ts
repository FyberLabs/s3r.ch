import assert from "node:assert/strict";
import { test } from "node:test";
import vectors from "./vectors/principal.json";
import forum from "./vectors/forums.json";
import { forumAgentSoul, isSeaPubkey, seaToPrincipalKey, seaFromPrincipalKey, sameEmbeddedPrincipal } from "./forum-check";

// Copied from SociACL vectors/ids/principal.json at b7f9bc59.
// Boolean validation adopts the same accept/reject boundary, not reason strings.
for (const row of vectors.accept) {
  test(`forum principal accepts ${row.name}`, () => {
    assert.equal(isSeaPubkey(row.input), true);
    assert.equal(seaToPrincipalKey(row.input), row.pathKey);
    assert.equal(seaFromPrincipalKey(row.pathKey), row.canonical);
    assert.equal(forumAgentSoul(forum.forumId, row.input).split("/").at(-1), row.input);
  });
}
for (const row of vectors.reject) {
  test(`forum principal rejects ${row.name}`, () => {
    const value = row.input as unknown as string;
    assert.equal(isSeaPubkey(value), false);
    assert.equal(seaToPrincipalKey(value), null);
    assert.equal(sameEmbeddedPrincipal(value, forum.statusId), false);
    assert.throws(() => forumAgentSoul(forum.forumId, value), /bad-principal/);
  });
}

test("inverse path-key conversion refuses an invalid curve point", () => {
  assert.equal(seaFromPrincipalKey(`p_${"00".repeat(64)}`), null);
});
