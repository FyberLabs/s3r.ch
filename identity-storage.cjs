// Development keeps a local JSON file. Production uses one Azure Blob.
const path = require("node:path");

function identityLinkPath(env = process.env, cwd = process.cwd()) {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "s3r.ch: production identity storage is Azure Blob; set S3RCH_IDENTITY_BLOB_ACCOUNT and S3RCH_IDENTITY_BLOB_CONTAINER",
    );
  }
  return env.S3RCH_IDENTITY_LINKS || path.join(cwd, "data", "identity-links.json");
}

function assertIdentityStorage(env = process.env, clientFactory) {
  if (env.NODE_ENV !== "production") return;
  const blob = require("./identity-blob.cjs");
  const config = blob.readBlobConfig(env);
  const factory = clientFactory || blob.createProductionBlobClient;
  blob.assertBlobReady(config, factory(config));
}

module.exports = { identityLinkPath, assertIdentityStorage };
