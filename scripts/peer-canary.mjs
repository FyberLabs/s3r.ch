import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const REVISION = /^[0-9a-f]{40}$/;

export const peerCases = [
  "peer-health", "peer-round-trip", "peer-reconnect", "peer-convergence",
];

export async function probePeer(origin, revision, { request = fetch, prefix = "/_peer" } = {}) {
  if (typeof revision !== "string" || !REVISION.test(revision)) throw Error("peer-revision-required");
  const options = { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) };
  async function read(path) {
    const response = await request(new URL(prefix + path, origin), options);
    if (response.status !== 200) throw Error("peer-probe-unavailable");
    return response.json();
  }
  const observed = await read("/api/version");
  if (observed.revision !== revision) throw Error("peer-revision-mismatch");
  if ((await read("/api/health")).status !== "ok") throw Error("peer-not-ready");
  return { revision: observed.revision };
}

export function peerCanaryFixture(value) {
  if (!value || !Object.keys(value).every(key => ["baseline_build", "baseline_revision", "candidate_revision"].includes(key)) ||
      typeof value.baseline_build !== "string" || !value.baseline_build.startsWith("/") ||
      ![value.baseline_revision, value.candidate_revision].every(rev => typeof rev === "string" && REVISION.test(rev)) ||
      value.baseline_revision === value.candidate_revision) throw Error("peer-canary-fixture-unavailable");
  return value;
}

// Infra records source identity and hashes immediately after each scheduled build.
export async function packagedPeerRevision(directory, expected) {
  const receipt = JSON.parse(await readFile(join(directory, "canary-artifact.json"), "utf8"));
  if (receipt.schema !== 1 || receipt.revision !== expected || !REVISION.test(receipt.revision)) {
    throw Error("peer-artifact-revision-mismatch");
  }
  const bytes = await readFile(join(directory, "seed-peer.cjs"));
  if (createHash("sha256").update(bytes).digest("hex") !== receipt.seed_sha256) {
    throw Error("peer-artifact-digest-mismatch");
  }
  return receipt.revision;
}
