import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { createAclStatementSource } from "./acl-statement-source-server";
import { createSpanopticonIdentityReplay } from "./identity/spanopticon-replay-server";
import { identitySessionNamespace } from "./identity/replay-namespace";
import { createSiteAclServer, getSiteAclServer } from "./site-acl-server";
import { parseSiteAclConfig } from "./site-acl-config";

const witnessSecret = new Uint8Array(32).fill(11);
const witnessPub = p256.getPublicKey(witnessSecret, false);
const authority = {
  keys: [{ crv: "P-256", kid: "w1", kty: "EC", notBefore: 0, notAfter: 9_999_999_999,
    x: Buffer.from(witnessPub.slice(1, 33)).toString("base64url"),
    y: Buffer.from(witnessPub.slice(33)).toString("base64url") }],
  pinnedIssuers: ["https://issuer.example"],
  policy: { allowedChainIds: ["eip155:1"], allowedDomains: ["s3r.ch"], allowedUris: ["https://s3r.ch"] },
};

test("site ACL server caches on env identity", () => {
  const config = parseSiteAclConfig({
    S3RCH_SITE_ORIGIN: "https://s3r.ch",
    S3RCH_FORUM_AUTHORITY: JSON.stringify(authority),
  });
  assert.ok(config);
  const statements = createAclStatementSource({
    origin: "https://acl.example", tenant: "11111111-1111-1111-1111-111111111111",
    scope: "s3rch-forum-statements", apiKey: "service-credential",
  });
  const replay = createSpanopticonIdentityReplay({
    origin: "https://storage.example", tenant: "11111111-1111-1111-1111-111111111111",
    apiKey: "service-credential", namespace: identitySessionNamespace("https://s3r.ch"),
  });
  const server = createSiteAclServer(config!, statements, replay, () => 100, "s".repeat(40));
  assert.equal(server.backend, "acl");
  assert.throws(() => createSiteAclServer(config!, statements, undefined as never, () => 100, "s".repeat(40)),
    /requires configured identity replay/);
});

test("getSiteAclServer requires statement source", () => {
  const keys = ["S3RCH_SITE_ORIGIN", "S3RCH_FORUM_AUTHORITY", "S3RCH_AUTHORITY_BACKEND",
    "S3RCH_STATEMENT_SOURCE_ORIGIN", "S3RCH_STATEMENT_SOURCE_TENANT_ID", "S3RCH_STATEMENT_SOURCE_SCOPE",
    "S3RCH_SERVICE_CREDENTIAL", "S3RCH_IDENTITY_REPLAY_BACKEND", "S3RCH_IDENTITY_REPLAY_ORIGIN",
    "S3RCH_IDENTITY_REPLAY_TENANT_ID", "S3RCH_SESSION_SIGNING_KEY"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.S3RCH_SITE_ORIGIN = "https://s3r.ch";
    process.env.S3RCH_FORUM_AUTHORITY = JSON.stringify(authority);
    process.env.S3RCH_AUTHORITY_BACKEND = "acl";
    process.env.S3RCH_STATEMENT_SOURCE_ORIGIN = "https://acl.example";
    process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID = "11111111-1111-1111-1111-111111111111";
    process.env.S3RCH_STATEMENT_SOURCE_SCOPE = "s3rch-forum-statements";
    process.env.S3RCH_SERVICE_CREDENTIAL = "service-credential";
    process.env.S3RCH_IDENTITY_REPLAY_BACKEND = "spanopticon";
    process.env.S3RCH_IDENTITY_REPLAY_ORIGIN = "https://storage.example";
    process.env.S3RCH_IDENTITY_REPLAY_TENANT_ID = "11111111-1111-1111-1111-111111111111";
    process.env.S3RCH_SESSION_SIGNING_KEY = "s".repeat(40);
    delete process.env.S3RCH_STATEMENT_SOURCE_KEY_VAULT_URI;
    delete process.env.S3RCH_STATEMENT_SOURCE_ORIGIN;
    assert.throws(() => getSiteAclServer(), /Statement source not configured|ACL statement source/);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});