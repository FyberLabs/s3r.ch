import assert from "node:assert/strict";
import test from "node:test";
import { startupConfiguration } from "./startup-configuration";

test("startup reports names only and recognizes unresolved Key Vault references", () => {
  const report = startupConfiguration({
    S3RCH_RELEASE_COLOR: "test",
    APP_BUILD_REVISION: "a".repeat(40),
    S3RCH_SESSION_SIGNING_KEY: "@Microsoft.KeyVault(SecretUri=private-reference)",
    S3RCH_IDENTITY_BLOB_ACCOUNT: "private-account",
    S3RCH_IDENTITY_BLOB_CONTAINER: "private-container",
    S3RCH_MEDIA_SIGNING_KEY: "private-media",
    S3RCH_SERVICE_CREDENTIAL: "private-service",
    S3RCH_AUTHORITY_BACKEND: "acl",
    S3RCH_SITE_ORIGIN: "private-origin",
    S3RCH_FORUM_AUTHORITY: "private-authority",
    S3RCH_STATEMENT_SOURCE_ORIGIN: "private-origin",
    S3RCH_STATEMENT_SOURCE_TENANT_ID: "private-tenant",
    S3RCH_STATEMENT_SOURCE_SCOPE: "private-scope",
    S3RCH_STATEMENT_SOURCE_KEY_VAULT_URI: "private-uri",
  });
  assert.deepEqual(report?.missing.sort(), ["AZURE_CLIENT_ID", "S3RCH_SESSION_SIGNING_KEY"].sort());
  assert.doesNotMatch(JSON.stringify(report), /private-/);
});

test("inactive features and local startup do not emit feature requirements", () => {
  assert.equal(startupConfiguration({}), undefined);
  const report = startupConfiguration({
    S3RCH_RELEASE_COLOR: "production", APP_BUILD_REVISION: "b".repeat(40),
    S3RCH_SESSION_SIGNING_KEY: "fixture", S3RCH_MEDIA_SIGNING_KEY: "fixture",
    S3RCH_SERVICE_CREDENTIAL: "fixture", S3RCH_IDENTITY_BLOB_ACCOUNT: "fixture",
    S3RCH_IDENTITY_BLOB_CONTAINER: "fixture",
  });
  assert.deepEqual(report?.missing, []);
});

test("startup diagnostics cover both production aliases and staging", () => {
  for (const color of ["blue", "green", "staging"]) {
    assert.equal(startupConfiguration({ S3RCH_RELEASE_COLOR: color })?.release, color);
  }
});
