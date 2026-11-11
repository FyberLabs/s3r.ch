// Run inside the built image at the same paths the TEST edge publisher extracts.
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import worker from "/app/edge-entry.mjs";

assert.equal(typeof worker.fetch, "function");
const root = "/app/edge-assets";
const assets = new Set(["_redirects", "favicon.svg", "og.svg"]);
const documents = ["index", "404", "feed", "feed/squad", "forum", "features",
  "features/groups", "features/gun", "features/social", "features/sociacl", "features/workspace",
  "saved-view", "views/picker-preview"];
for (const name of documents) {
  const html = await readFile(join(root, name + ".html"), "utf8");
  assert.match(html, /<html\b/i, name);
  assert.match(html, /<script\b[^>]*\bsrc="\/_next\/static\//i, name);
  for (const [, path] of html.matchAll(/\b(?:src|href)="\/(_next\/static\/[^"?#]+|brand\/[^"?#]+)(?:[?#][^"]*)?"/g)) {
    assets.add(decodeURIComponent(path));
  }
}
for (const asset of assets) {
  const file = await stat(join(root, asset));
  assert.ok(file.isFile() && file.size > 0, asset);
}
console.log(`Verified ${documents.length} public documents and ${assets.size} files in the edge payload.`);
