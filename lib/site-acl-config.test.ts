import assert from "node:assert/strict";
import test from "node:test";
import { deriveSiteForumAuthority, parseSiteAclConfig, resolveSiteOrigin } from "./site-acl-config";

test("deriveSiteForumAuthority binds SIWE policy to the canonical site origin", () => {
  const authority = deriveSiteForumAuthority("https://test.s3r.ch");
  assert.deepEqual(authority.keys, []);
  assert.deepEqual(authority.pinnedIssuers, []);
  assert.deepEqual(authority.policy.allowedDomains, ["test.s3r.ch"]);
  assert.deepEqual(authority.policy.allowedUris, ["https://test.s3r.ch"]);
  assert.deepEqual(authority.policy.allowedChainIds, []);
});

test("resolveSiteOrigin prefers explicit configuration then GUN health peer URL", () => {
  assert.equal(resolveSiteOrigin({ S3RCH_SITE_ORIGIN: "https://custom.s3r.ch" }), "https://custom.s3r.ch");
  assert.equal(resolveSiteOrigin({
    S3RCH_GUN_HEALTH_URL: "https://test.s3r.ch/_peer/api/health",
  }), "https://test.s3r.ch");
  assert.equal(resolveSiteOrigin({ S3RCH_RELEASE_COLOR: "test" }), "https://test.s3r.ch");
  assert.equal(resolveSiteOrigin({ S3RCH_RELEASE_COLOR: "production" }), "https://s3r.ch");
  assert.equal(resolveSiteOrigin({}), undefined);
});

test("parseSiteAclConfig enables on ACL backend and inferred origin only", () => {
  assert.equal(parseSiteAclConfig({}), null);
  assert.equal(parseSiteAclConfig({ S3RCH_AUTHORITY_BACKEND: "acl", S3RCH_RELEASE_COLOR: "production" })?.origin,
    "https://s3r.ch");
  assert.equal(parseSiteAclConfig({
    S3RCH_AUTHORITY_BACKEND: "acl",
    S3RCH_GUN_HEALTH_URL: "https://s3r.ch/_peer/api/health",
  })?.origin, "https://s3r.ch");
  assert.equal(parseSiteAclConfig({ S3RCH_RELEASE_COLOR: "production" }), null);
});