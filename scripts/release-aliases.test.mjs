import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareSemver, shouldAdvanceAlias } from "./release-aliases.mjs";

describe("release aliases", () => {
  it("moves latest forward and refuses an older maintenance tag", () => {
    assert.equal(compareSemver("1.3.0", "1.2.4") > 0, true);
    assert.equal(shouldAdvanceAlias("1.2.4", "1.3.0"), true);
    assert.equal(shouldAdvanceAlias("1.3.0", "1.2.4"), false);
  });

  it("moves a minor alias only within newer or equal patch versions", () => {
    assert.equal(shouldAdvanceAlias("1.2.3", "1.2.4"), true);
    assert.equal(shouldAdvanceAlias("1.2.9", "1.2.4"), false);
    assert.equal(shouldAdvanceAlias("1.2.4", "1.2.4"), true);
  });

  it("sets an alias that does not exist yet", () => {
    assert.equal(shouldAdvanceAlias(null, "1.2.4"), true);
    assert.equal(shouldAdvanceAlias("", "1.2.4"), true);
  });

  it("rejects versions outside X.Y.Z", () => {
    assert.throws(() => shouldAdvanceAlias("1.2", "1.2.4"), /X\.Y\.Z/);
    assert.throws(() => shouldAdvanceAlias(null, "v1.2.4"), /X\.Y\.Z/);
  });
});
