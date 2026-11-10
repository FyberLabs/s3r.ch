import assert from "node:assert/strict";
import { test } from "node:test";
import vector from "./vectors/forums.json";
import { acceptHint, checkSee } from "./check";
import { createMemorySeeAcl } from "./see-acl";

test("SociACL forum hint does not grant access to its target", () => {
  const acl = createMemorySeeAcl();
  const hint = acceptHint(vector.hint.fields);
  assert.deepEqual(hint, vector.hint.fields);
  acl.putObject(hint.target, vector.seaPubkey);
  assert.equal(checkSee(acl, hint.target, hint.principal, 1000, hint).allowed, false);
  assert.equal(checkSee(acl, hint.target, hint.principal, 1000).allowed, false);
});
