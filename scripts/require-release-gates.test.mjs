import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gateErrors, trustedTreeErrors } from "./require-release-gates.mjs";

describe("release gates", () => {
  it("rejects an unprotected or missing default branch", () => {
    assert.deepEqual(gateErrors({ name: "master", protected: false }), ["Branch master is not protected."]);
    assert.deepEqual(gateErrors(undefined), ["Branch default branch is not protected."]);
  });

  it("rejects release scripts that are missing or differ from the default branch", () => {
    const errors = trustedTreeErrors([
      { path: "scripts/require-release-gates.mjs", present: true, same: false },
      { path: "scripts/publish-version-tag.mjs", present: false, same: false },
    ]);
    assert.match(errors[0], /does not match the default branch/);
    assert.match(errors[1], /is not on the default branch/);
  });

  it("accepts a protected branch without an environment reviewer", () => {
    assert.deepEqual(gateErrors({ name: "master", protected: true }), []);
  });
});
