import assert from "node:assert/strict";
import test from "node:test";
import { resolveSiteOrigin } from "./site-origin";

test("resolveSiteOrigin prefers explicit configuration then GUN health peer URL", () => {
  assert.equal(resolveSiteOrigin({ S3RCH_SITE_ORIGIN: "https://custom.s3r.ch" }), "https://custom.s3r.ch");
  assert.equal(resolveSiteOrigin({
    S3RCH_GUN_HEALTH_URL: "https://test.s3r.ch/_peer/api/health",
  }), "https://test.s3r.ch");
  assert.equal(resolveSiteOrigin({ S3RCH_RELEASE_COLOR: "test" }), "https://test.s3r.ch");
  assert.equal(resolveSiteOrigin({ S3RCH_RELEASE_COLOR: "production" }), "https://s3r.ch");
  assert.equal(resolveSiteOrigin({}), undefined);
});