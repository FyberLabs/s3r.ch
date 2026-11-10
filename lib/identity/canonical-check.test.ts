import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSee, checkForumSee, checkSeeGrant, applySeeGrant, cancelSee, type SeeGraph } from "./check";
import { createMemorySeeAcl } from "./see-acl";
import vector from "./vectors/forums.json";
import principals from "./vectors/principal.json";

const object = vector.needId, owner = vector.seaPubkey, accessor = vector.secondPubkey;
const grant = { claimId: object, accessor, from: 0, until: 2000 };
function graph(overrides: Partial<SeeGraph> = {}): SeeGraph {
  return { hasObject: id => id === object, ownerOf: () => owner, seeGrants: () => [grant], ...overrides };
}

for (const check of [checkSee, checkForumSee]) {
  test(`${check.name}: canonical owner and exact live grant remain allowed`, () => {
    assert.equal(check(graph(), object, owner, 1000).reason, "owner");
    assert.equal(check(graph(), object, accessor, 1000).reason, "see-grant");
    assert.equal(check(graph(), object, accessor, 2000).allowed, false);
    assert.equal(check(graph({ seeGrants: () => [] }), object, accessor, 1000).allowed, false);
  });
  test(`${check.name}: canonical objects reject credential and user-path aliases`, () => {
    for (const bad of [vector.linkedWallet, `s3rch/users/${owner}`, `s3rch/users/${accessor}`,
      ` ${accessor} `, principals.accept[1].pathKey, ...principals.reject.map(row => row.input)]) {
      const input = bad as unknown as string;
      assert.equal(check(graph(), object, input, 1000).allowed, false);
      assert.equal(check(graph({ ownerOf: () => input }), object, accessor, 1000).allowed, false);
    }
  });
  test(`${check.name}: legacy grant aliases cannot authorize a canonical object`, () => {
    for (const row of [{ ...grant, accessor: `s3rch/users/${accessor}` },
      { ...grant, accessor: ` ${accessor} ` }, { ...grant, claimId: ` ${object} ` },
      { ...grant, claimId: `s3rch/items/${object}` }]) {
      assert.equal(check(graph({ seeGrants: () => [row] }), object, accessor, 1000).allowed, false);
    }
  });
  test(`${check.name}: invalid principals cannot reach permissive authority callbacks`, () => {
    const allow = () => { throw Error("invalid principal reached authority callback"); };
    const authority = graph({ checkDirectSee: allow, checkForumSee: allow });
    assert.equal(check(authority, object, vector.linkedWallet, 1000).allowed, false);
    assert.equal(check(authority, object, `s3rch/users/${accessor}`, 1000).allowed, false);
  });
}

test("presented grants cannot smuggle aliases through an already allowed destination", () => {
  for (const row of [{ ...grant, accessor: `s3rch/users/${accessor}` },
    { ...grant, accessor: ` ${accessor} ` }, { ...grant, claimId: ` ${object} ` }]) {
    assert.equal(checkSeeGrant(graph(), row, object, accessor, 1000).allowed, false);
  }
});

test("a user-path alias cannot mutate a SEA owner's canonical grants", () => {
  const acl = createMemorySeeAcl();
  acl.putObject(object, owner);
  applySeeGrant(acl, `s3rch/users/${owner}`, grant);
  assert.equal(checkSee(acl, object, accessor, 1000).allowed, false);
  applySeeGrant(acl, owner, grant);
  assert.equal(checkSee(acl, object, accessor, 1000).allowed, true);
  cancelSee(acl, `s3rch/users/${owner}`, accessor, object);
  assert.equal(checkSee(acl, object, accessor, 1000).allowed, true);
  cancelSee(acl, owner, accessor, object);
  assert.equal(checkSee(acl, object, accessor, 1000).allowed, false);
});
