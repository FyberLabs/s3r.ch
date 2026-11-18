import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { blobConflict, type IdentityBlobClient } from "../identity-blob.cjs";
import { BlobForumStore, FORUM_BLOB, migrateForum } from "../lib/forum-blob";
import { emptyForumFile, openForum } from "../lib/forum";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_EVENT_NAME !== "schedule" ||
    process.env.GITHUB_WORKFLOW_REF !== "FyberLabs/infra/.github/workflows/nightly-integration.yml@refs/heads/main" ||
    process.env.NIGHTLY_SUITE !== "s3rch-web-canary") throw Error("Scheduled web canary required");

async function main() {
  const root = process.argv[2];
  assert.ok(root?.startsWith("/") && root !== process.cwd(), "distinct baseline source required");
  const oldStore: typeof import("../lib/forum-blob") = await import(pathToFileURL(join(root, "lib/forum-blob.ts")).href);
  const oldForum: typeof import("../lib/forum") = await import(pathToFileURL(join(root, "lib/forum.ts")).href);
  const owner = "PtETt4g7TFkGODedsMIc2hZ0LtAlUEi_QzOR03S8IdE.kJkgmszEyKIkyEOvpPTGigkNBNpemIna4vju_OgqN0A";
  let text: string | undefined;
  let etag = 0;
  const blob: IdentityBlobClient = {
    assertReachable() {},
    download(name) {
      assert.equal(name, FORUM_BLOB);
      return text === undefined ? { found: false } : { found: true, text, etag: String(etag) };
    },
    upload(name, next, conditions) {
      assert.equal(name, FORUM_BLOB);
      if (text === undefined ? conditions.ifNoneMatch !== "*" : conditions.ifMatch !== String(etag)) {
        throw blobConflict();
      }
      text = next;
      return { etag: String(++etag) };
    },
  };
  migrateForum(blob, emptyForumFile(), [owner]);
  const baseline = oldForum.openForum(new oldStore.BlobForumStore(blob));
  const candidate = openForum(new BlobForumStore(blob));
  const initial = baseline.registerBot({ owner, label: "baseline", entropy: "0101" });
  assert.ok(!("denied" in initial));
  const updated = candidate.registerBot({ owner, label: "candidate", entropy: "0202" });
  assert.ok(!("denied" in updated));
  const restored = new oldStore.BlobForumStore(blob).load();
  assert.ok(restored.ok);
  assert.deepEqual(restored.file.bots.map(bot => bot.id).sort(), [initial.bot.id, updated.bot.id].sort());
  console.log(JSON.stringify({ name: "forum-round-trip", status: "passed" }));
}

void main().catch(() => {
  console.error("Forum canary compatibility failed");
  process.exitCode = 1;
});
