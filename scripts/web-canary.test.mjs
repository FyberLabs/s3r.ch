import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { browserWebCanary, verifyWebCanary } from "./web-canary.mjs";

const worker = "a9fcee52-d961-4755-98df-c162632c7340";
const revision = "a".repeat(40), bytes = Buffer.from("<html>fixture</html>");
const expected = { worker, revision, asset_sha256: createHash("sha256").update(bytes).digest("hex") };
const observation = { expected, asset: { worker, bytes }, origin: { worker, revision } };

test("document and origin need matching independent attribution", () => {
  assert.deepEqual(verifyWebCanary(observation), { cases: ["public-assets", "origin-fallthrough"], worker, revision });
  assert.throws(() => verifyWebCanary({ ...observation, asset: { bytes } }), /worker-version-mismatch/);
  assert.throws(() => verifyWebCanary({ ...observation, origin: { worker, revision: "b".repeat(40) } }), /origin-revision-mismatch/);
  assert.throws(() => verifyWebCanary({ ...observation, asset: { worker, bytes: Buffer.from("different") } }), /static-asset-mismatch/);
});

test("browser attributes the document and origin using one context", async () => {
  const paths = [];
  const page = {
    goto: async url => {
      paths.push(url);
      return { status: () => 200, url: () => url, headers: () => ({ "x-s3rch-worker-version": worker }), body: async () => bytes };
    },
    evaluate: async run => {
      assert.match(String(run), /fetch\("\/api\/version"/);
      paths.push("/api/version");
      return { worker, revision };
    },
  };
  assert.equal((await browserWebCanary(page, "https://fixture.test", expected)).revision, revision);
  assert.deepEqual(paths, ["https://fixture.test/feed", "/api/version"]);
});
