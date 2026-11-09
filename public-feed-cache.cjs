// Only the seeder's public snapshot belongs here. Publish by rename so a
// static-file reader sees one complete generation while the seed is updating.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function publishPublicFeed(root, snapshot) {
  const destination = path.join(root, "public", "feed-cache", "snapshot.json");
  const temporary = destination + "." + randomUUID();
  const { items, seededAt, sourcesOk, sourcesTried, error } = snapshot;
  fs.writeFileSync(temporary, JSON.stringify({
    items, seededAt, sourcesOk, sourcesTried,
    error: error ? "The last public feed refresh failed." : null,
  }));
  fs.renameSync(temporary, destination);
}

function restorePublicFeed(root, snapshotFile) {
  let snapshot = { items: [], seededAt: null, sourcesOk: 0, sourcesTried: 0, error: null };
  try {
    const stored = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
    if (Array.isArray(stored.items)) snapshot = stored;
  } catch (error) {
    if (error.code !== "ENOENT") snapshot.error = "Unreadable snapshot";
  }
  publishPublicFeed(root, snapshot);
}

module.exports = { publishPublicFeed, restorePublicFeed };
