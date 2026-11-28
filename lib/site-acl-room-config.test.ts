import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { parseSiteAclConfig } from "./site-acl-config";
import { createSiteAclServer } from "./site-acl-server";
import { createAclStatementSource } from "./acl-statement-source-server";
import { createSpanopticonIdentityReplay } from "./identity/spanopticon-replay-server";
import { identitySessionNamespace } from "./identity/replay-namespace";
import { siteRoomConfigResponse, siteRoomConfigResult } from "./site-acl-room-config";

const witnessSecret = new Uint8Array(32).fill(11);
const witnessPub = p256.getPublicKey(witnessSecret, false);
const authority = {
  keys: [{ crv: "P-256", kid: "w1", kty: "EC", notBefore: 0, notAfter: 9_999_999_999,
    x: Buffer.from(witnessPub.slice(1, 33)).toString("base64url"),
    y: Buffer.from(witnessPub.slice(33)).toString("base64url") }],
  pinnedIssuers: ["https://issuer.example"],
  policy: { allowedChainIds: ["eip155:1"], allowedDomains: ["s3r.ch"], allowedUris: ["https://s3r.ch"] },
};

test("site room-config GET requires a session and returns public client endpoints", async () => {
  const unauth = await siteRoomConfigResponse(new Request("https://s3r.ch/api/site/room-config"));
  assert.equal(unauth.status, 401);
  assert.equal(siteRoomConfigResult(false, null).status, 401);
  const config = parseSiteAclConfig({
    S3RCH_FORUM_AUTHORITY: JSON.stringify(authority),
    S3RCH_RELEASE_COLOR: "production",
  })!;
  const statements = createAclStatementSource({
    origin: "https://acl.example", tenant: "11111111-1111-1111-1111-111111111111",
    scope: "s3rch-forum-statements", apiKey: "service-credential",
  });
  const replay = createSpanopticonIdentityReplay({
    origin: "https://storage.example", tenant: "11111111-1111-1111-1111-111111111111",
    apiKey: "service-credential", namespace: identitySessionNamespace("https://s3r.ch"),
  });
  const site = createSiteAclServer(config, statements, replay, () => 100, "s".repeat(40));
  const result = siteRoomConfigResult(true, site);
  assert.equal(result.status, 200);
  assert.equal(result.config?.statementEndpoint, "/api/site/statement");
  assert.equal(result.config?.authorityEndpoint, "/api/site/authority");
  assert.equal(siteRoomConfigResult(true, null).status, 404);
});