import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { versionTagPlan } from "./version-tag-plan.mjs";

const DIGEST = `sha256:${"ab".repeat(32)}`;

describe("version tag plan", () => {
  it("pushes when the version tag is absent", () => {
    assert.deepEqual(versionTagPlan(null, "1.2.4"), { action: "push" });
    assert.deepEqual(versionTagPlan(undefined, "1.2.4"), { action: "push" });
  });

  it("reuses a published tag with the same version label", () => {
    assert.deepEqual(versionTagPlan({ digest: DIGEST, versionLabel: "1.2.4" }, "1.2.4"), {
      action: "reuse",
      digest: DIGEST,
    });
  });

  it("refuses to replace a tag that has a different or missing label", () => {
    assert.throws(() => versionTagPlan({ digest: DIGEST, versionLabel: "1.2.3" }, "1.2.4"), /refusing to replace/);
    assert.throws(() => versionTagPlan({ digest: DIGEST, versionLabel: "" }, "1.2.4"), /unlabeled/);
    assert.throws(() => versionTagPlan({ digest: "sha256:nope", versionLabel: "1.2.4" }, "1.2.4"), /digest/);
  });
});
