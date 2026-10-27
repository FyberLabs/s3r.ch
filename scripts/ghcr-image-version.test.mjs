import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { platformManifestDigest, versionFromImageConfig } from "./ghcr-image-version.mjs";

describe("GHCR image version", () => {
  it("reads the version label and ignores other text", () => {
    assert.equal(
      versionFromImageConfig({
        config: { Labels: { "org.opencontainers.image.version": "1.2.4" } },
      }),
      "1.2.4",
    );
    assert.equal(
      versionFromImageConfig({
        config: { Labels: { "org.opencontainers.image.version": "latest" } },
      }),
      null,
    );
  });

  it("picks the linux/amd64 digest from an index", () => {
    assert.equal(
      platformManifestDigest({
        manifests: [
          { digest: "sha256:aa", platform: { os: "linux", architecture: "arm64" } },
          { digest: "sha256:bb", platform: { os: "linux", architecture: "amd64" } },
        ],
      }),
      "sha256:bb",
    );
    assert.equal(platformManifestDigest({ config: { digest: "sha256:cc" } }), null);
  });
});
