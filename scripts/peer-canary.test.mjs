import assert from "node:assert/strict";
import test from "node:test";
import { peerCanaryFixture, probePeer } from "./peer-canary.mjs";

const baseline = "a".repeat(40), candidate = "b".repeat(40);

test("probe attributes the peer via its edge routes", async () => {
  const paths = [];
  const result = await probePeer("https://example.test", baseline, {
    request: async (url, options) => {
      paths.push(url.pathname);
      assert.equal(options.redirect, "error");
      return Response.json(url.pathname.endsWith("version") ? { revision: baseline } : { status: "ok" });
    },
  });
  assert.deepEqual(paths, ["/_peer/api/version", "/_peer/api/health"]);
  assert.deepEqual(result, { revision: baseline });
});

test("health from a mismatched or empty revision cannot attest the peer", async () => {
  for (const revision of [candidate, null]) {
    await assert.rejects(probePeer("https://example.test", baseline, {
      request: async () => Response.json({ revision }),
    }), /peer-revision-mismatch/);
  }
});

test("candidate and baseline fixture revisions must differ", () => {
  const input = { baseline_build: "/tmp/previous", baseline_revision: baseline, candidate_revision: candidate };
  assert.equal(peerCanaryFixture(input), input);
  assert.throws(() => peerCanaryFixture({ ...input, candidate_revision: baseline }), /fixture-unavailable/);
});

test("artifact attribution rejects a swapped label and altered package bytes", async () => {
  const { createHash } = await import("node:crypto");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { packagedPeerRevision } = await import("./peer-canary.mjs");
  const directory = await mkdtemp(join(tmpdir(), "peer-artifact-contract-"));
  try {
    const bytes = "packaged-peer";
    await writeFile(join(directory, "seed-peer.cjs"), bytes);
    await writeFile(join(directory, "canary-artifact.json"), JSON.stringify({
      schema: 1, revision: baseline, seed_sha256: createHash("sha256").update(bytes).digest("hex"),
    }));
    assert.equal(await packagedPeerRevision(directory, baseline), baseline);
    await assert.rejects(packagedPeerRevision(directory, candidate), /revision-mismatch/);
    await writeFile(join(directory, "seed-peer.cjs"), "different");
    await assert.rejects(packagedPeerRevision(directory, baseline), /digest-mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
