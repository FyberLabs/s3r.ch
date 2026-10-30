import assert from "node:assert/strict";
import { test } from "node:test";
import { forumSoulNode } from "./forum-transport";
import {
  forumAgentSoul, forumArtifactSoul, forumRoleSoul, forumSubtaskSoul, forumUpdateSoul,
} from "./identity/check";
import doc from "./identity/vectors/forums.json";

function recorder() {
  const segments: string[] = [];
  const node = { get(key: string) { segments.push(key); return node; } };
  return { node, segments };
}

for (const [name, soul] of [
  ["agent", forumAgentSoul(doc.forumId, doc.seaPubkey)],
  ["subtask", forumSubtaskSoul(doc.forumId, doc.seaPubkey, doc.statusId)],
  ["update", forumUpdateSoul(doc.forumId, doc.seaPubkey, doc.needId)],
  ["artifact", forumArtifactSoul(doc.forumId, doc.seaPubkey, doc.specId)],
] as const) {
  test(`${name} traverses the shared soul with an intact SEA pubkey`, () => {
    const { node, segments } = recorder();
    assert.equal(soul, doc.souls[name]);
    assert.equal(forumSoulNode(node, soul), node);
    assert.deepEqual(segments.slice(0, 5), ["s3rch", "forums", doc.forumId, "agents", doc.seaPubkey]);
    assert.equal(segments.join("/"), soul);
    assert.equal(segments.length, name === "agent" ? 5 : 7);
  });
}

test("role membership keeps the public key in one get call", () => {
  const { node, segments } = recorder();
  forumSoulNode(node, forumRoleSoul(doc.forumId, "helper", doc.seaPubkey));
  assert.deepEqual(segments, ["s3rch", "forums", doc.forumId, "roles", "helper", doc.seaPubkey]);
});

test("malformed or separate chat paths make no graph calls", () => {
  for (const path of ["", "/s3rch/items/a", "s3rch//items/a", "s3rch/items/a/", "s3rch/chat/a", "s3rch/forums/a/chat/b"]) {
    const { node, segments } = recorder();
    assert.equal(forumSoulNode(node, path), null, path);
    assert.deepEqual(segments, [], path);
  }
});

test("artifact builder refuses malformed identity and child paths", () => {
  assert.throws(() => forumArtifactSoul(doc.needId, doc.seaPubkey, doc.specId), /bad-id/);
  assert.throws(() => forumArtifactSoul(doc.forumId, doc.linkedWallet, doc.specId), /bad-principal/);
  for (const id of ["chat", "../escape", `${doc.specId}/nested`, "ext_" + "a".repeat(64)]) {
    assert.throws(() => forumArtifactSoul(doc.forumId, doc.seaPubkey, id), /bad-id/);
  }
});
