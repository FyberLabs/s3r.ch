import assert from "node:assert/strict";
import test from "node:test";
import { parseSiteAclConfig } from "./site-acl-config";
import { createSiteAclServer } from "./site-acl-server";
import { createAclStatementSource } from "./acl-statement-source-server";
import { createSpanopticonIdentityReplay } from "./identity/spanopticon-replay-server";
import { identitySessionNamespace } from "./identity/replay-namespace";
import { siteRoomConfigResponse, siteRoomConfigResult } from "./site-acl-room-config";

test("site room-config GET requires a session and returns public client endpoints", async () => {
  const unauth = await siteRoomConfigResponse(new Request("https://s3r.ch/api/site/room-config"));
  assert.equal(unauth.status, 401);
  assert.equal(siteRoomConfigResult(false, null).status, 401);
  const config = parseSiteAclConfig({
    S3RCH_AUTHORITY_BACKEND: "acl",
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