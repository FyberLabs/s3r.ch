import assert from "node:assert/strict";
import test from "node:test";
import { createAclStatementSource } from "./acl-statement-source-server";
import { createSpanopticonIdentityReplay } from "./identity/spanopticon-replay-server";
import { identitySessionNamespace } from "./identity/replay-namespace";
import { createSquadForumServer } from "./squad-forum-server";
import { SEA_OWNED_FORUM_AUTHORITY } from "./sea-owned-forum-policy";

test("createSquadForumServer uses empty deployment witness policy", () => {
  const statements = createAclStatementSource({
    origin: "https://acl.example", tenant: "11111111-1111-1111-1111-111111111111",
    scope: "s3rch-forum-statements", apiKey: "service-credential",
  });
  const replay = createSpanopticonIdentityReplay({
    origin: "https://storage.example", tenant: "11111111-1111-1111-1111-111111111111",
    apiKey: "service-credential", namespace: identitySessionNamespace("https://s3r.ch"),
  });
  const server = createSquadForumServer("https://s3r.ch", statements, replay, () => 100, "s".repeat(40));
  assert.equal(server.backend, "acl");
  assert.deepEqual(server.config, SEA_OWNED_FORUM_AUTHORITY);
  assert.throws(() => createSquadForumServer("https://s3r.ch", statements, undefined as never, () => 100, "s".repeat(40)),
    /requires configured identity replay/);
});