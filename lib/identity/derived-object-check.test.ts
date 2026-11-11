import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSee, checkForumSee, checkSeeGrant, applySeeGrant, cancelSee, type SeeGraph } from "./check";
import { createMemorySeeAcl } from "./see-acl";
import { isCanonicalObjectId, usesCanonicalObjectNamespace } from "./object-id";
import objects from "./vectors/object.json";
import principals from "./vectors/principal.json";

const owner = principals.accept[0].input, accessor = principals.accept[1].input;
const derived = objects.accept.filter(row => row.operation === "claim" || row.operation === "external");
for (const row of derived) {
  const object = row.canonical;
  const grant = { claimId: object, accessor, from: 0, until: 2000 };
  for (const check of [checkSee, checkForumSee]) {
    test(`${check.name}: ${row.name} requires an exact SEA grant`, () => {
      const acl = createMemorySeeAcl(); acl.putObject(object, owner);
      applySeeGrant(acl, owner, grant);
      assert.equal(check(acl, object, owner, 1000).allowed, true);
      assert.equal(check(acl, object, accessor, 1000).allowed, true);
      assert.equal(check(acl, object, `s3rch/users/${accessor}`, 1000).allowed, false);
      assert.equal(check(acl, object, "0x1efF47bc3a10a45D4B230B5d10E37751FE6AA718", 1000).allowed, false);
      assert.equal(checkSeeGrant(acl, { ...grant, claimId: ` ${object} ` }, object, accessor, 1000).allowed, false);
      assert.equal(check(acl, object, accessor, 2000).allowed, false);
      cancelSee(acl, `s3rch/users/${owner}`, accessor, object);
      assert.equal(check(acl, object, accessor, 1000).allowed, true);
      cancelSee(acl, owner, accessor, object);
      assert.equal(check(acl, object, accessor, 1000).allowed, false);
    });
    test(`${check.name}: ${row.name} rejects wallet owners before authority callbacks`, () => {
      const graph: SeeGraph = { hasObject: () => true, ownerOf: () => "0x1efF47bc3a10a45D4B230B5d10E37751FE6AA718", seeGrants: () => [grant],
        checkDirectSee: () => { throw Error("callback reached"); }, checkForumSee: () => { throw Error("callback reached"); } };
      assert.equal(check(graph, object, accessor, 1000).allowed, false);
    });
  }
}
for (const row of objects.reject.filter(row => (!row.operation || row.operation === "parse") && usesCanonicalObjectNamespace(row.input))) {
  test(`malformed canonical namespace is denied before graph access: ${row.name}`, () => {
    const fail = () => { throw Error("malformed ID reached graph"); };
    const graph: SeeGraph = { hasObject: fail, ownerOf: fail, seeGrants: fail, checkDirectSee: fail, checkForumSee: fail };
    const object = row.input as unknown as string;
    assert.equal(isCanonicalObjectId(object), false);
    for (const check of [checkSee, checkForumSee]) assert.equal(check(graph, object, accessor, 1000).reason, "bad-object");
  });
}
