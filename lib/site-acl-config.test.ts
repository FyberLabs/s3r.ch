import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { parseSiteAclConfig, resolveSiteOrigin } from "./site-acl-config";

const witnessSecret = new Uint8Array(32).fill(11);
const witnessPub = p256.getPublicKey(witnessSecret, false);
const authority = JSON.stringify({
  keys: [{ crv: "P-256", kid: "w1", kty: "EC", notBefore: 0, notAfter: 9_999_999_999,
    x: Buffer.from(witnessPub.slice(1, 33)).toString("base64url"),
    y: Buffer.from(witnessPub.slice(33)).toString("base64url") }],
  pinnedIssuers: ["https://issuer.example"],
  policy: { allowedChainIds: ["eip155:1"], allowedDomains: ["s3r.ch"], allowedUris: ["https://s3r.ch"] },
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

test("parseSiteAclConfig stays disabled until witness policy is configured", () => {
  assert.equal(parseSiteAclConfig({}), null);
  assert.equal(parseSiteAclConfig({ S3RCH_FORUM_AUTHORITY: authority, S3RCH_RELEASE_COLOR: "production" })?.origin,
    "https://s3r.ch");
  assert.equal(parseSiteAclConfig({
    S3RCH_FORUM_AUTHORITY: authority,
    S3RCH_GUN_HEALTH_URL: "https://s3r.ch/_peer/api/health",
  })?.origin, "https://s3r.ch");
});