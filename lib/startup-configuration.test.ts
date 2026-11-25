import assert from "node:assert/strict";
import test from "node:test";
import { startupConfiguration } from "./startup-configuration";

test("startup reports names only and recognizes unresolved Key Vault references", () => {
  const report = startupConfiguration({
    S3RCH_RELEASE_COLOR: "test",
    APP_BUILD_REVISION: "a".repeat(40),
    IDENTITY_SESSION_SECRET: "@Microsoft.KeyVault(SecretUri=private-reference)",
    S3RCH_IDENTITY_BLOB_ACCOUNT: "private-account",
    S3RCH_IDENTITY_BLOB_CONTAINER: "private-container",
    S3RCH_AUTHORITY_BACKEND: "acl",
    S3RCH_SQUAD_PILOT: "private-config",
    S3RCH_STATEMENT_SOURCE_ORIGIN: "private-origin",
    S3RCH_STATEMENT_SOURCE_TENANT_ID: "private-tenant",
    S3RCH_STATEMENT_SOURCE_SCOPE: "private-scope",
    S3RCH_STATEMENT_SOURCE_KEY_VAULT_URI: "private-uri",
  });
  assert.deepEqual(report?.missing, ["AZURE_CLIENT_ID", "IDENTITY_SESSION_SECRET"]);
  assert.doesNotMatch(JSON.stringify(report), /private-/);
});

test("inactive features and local startup do not emit feature requirements", () => {
  assert.equal(startupConfiguration({}), undefined);
  const report = startupConfiguration({
    S3RCH_RELEASE_COLOR: "production", APP_BUILD_REVISION: "b".repeat(40),
    IDENTITY_SESSION_SECRET: "fixture", S3RCH_IDENTITY_BLOB_ACCOUNT: "fixture",
    S3RCH_IDENTITY_BLOB_CONTAINER: "fixture",
  });
  assert.deepEqual(report?.missing, []);
});
