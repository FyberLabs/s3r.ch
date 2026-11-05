import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trustedTreeErrors } from "./require-release-gates.mjs";

describe("release gates", () => {
  it("rejects release scripts that are missing or differ from the default branch", () => {
    const errors = trustedTreeErrors([
      { path: "scripts/require-release-gates.mjs", present: true, same: false },
      { path: "scripts/publish-version-tag.mjs", present: false, same: false },
    ]);
    assert.match(errors[0], /does not match the default branch/);
    assert.match(errors[1], /is not on the default branch/);
  });

  it("accepts matching release scripts on the default branch", () => {
    assert.deepEqual(trustedTreeErrors([
      { path: "scripts/release-channels.mjs", present: true, same: true },
    ]), []);
  });
});
