import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gateErrors, reviewerCount, trustedTreeErrors } from "./require-release-gates.mjs";

describe("release gates", () => {
  it("counts required reviewers", () => {
    assert.equal(
      reviewerCount({
        protection_rules: [
          { type: "required_reviewers", reviewers: [{ type: "User" }] },
        ],
      }),
      1,
    );
    assert.equal(reviewerCount({ protection_rules: [{ type: "wait_timer" }] }), 0);
    assert.equal(reviewerCount({}), 0);
  });

  it("rejects a missing reviewer and an unprotected default branch", () => {
    const errors = gateErrors({ protection_rules: [] }, { name: "master", protected: false });
    assert.equal(errors.length, 2);
    assert.match(errors[0], /require at least one reviewer/);
    assert.match(errors[1], /master is not protected/);
  });

  it("rejects release scripts that are missing or differ from the default branch", () => {
    const errors = trustedTreeErrors([
      { path: "scripts/require-release-gates.mjs", present: true, same: false },
      { path: "scripts/publish-version-tag.mjs", present: false, same: false },
    ]);
    assert.match(errors[0], /does not match the default branch/);
    assert.match(errors[1], /is not on the default branch/);
  });

  it("accepts a reviewed environment and a protected branch", () => {
    const errors = gateErrors(
      { protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User" }] }] },
      { name: "master", protected: true },
    );
    assert.deepEqual(errors, []);
  });
});
