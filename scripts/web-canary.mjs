import { createHash } from "node:crypto";

const workerVersion = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const revision = /^[0-9a-f]{40}$/;
const sha256 = /^[0-9a-f]{64}$/;

export function verifyWebCanary({ expected, asset, origin }) {
  if (!workerVersion.test(expected.worker) || !revision.test(expected.revision) ||
      !sha256.test(expected.asset_sha256)) throw Error("web-canary-target-invalid");
  if (asset.worker !== expected.worker || origin.worker !== expected.worker) throw Error("worker-version-mismatch");
  if (origin.revision !== expected.revision) throw Error("origin-revision-mismatch");
  if (!Buffer.isBuffer(asset.bytes) || asset.bytes.length < 1 || asset.bytes.length > 16 * 1024 * 1024 ||
      createHash("sha256").update(asset.bytes).digest("hex") !== expected.asset_sha256) {
    throw Error("static-asset-mismatch");
  }
  return { cases: ["public-assets", "origin-fallthrough"], worker: origin.worker, revision: origin.revision };
}

/** Browser probes keep the same page/context affinity across document and origin requests. */
export async function browserWebCanary(page, origin, expected) {
  const asset = await page.goto(new URL("/feed", origin).href, { waitUntil: "domcontentloaded", timeout: 15000 });
  if (asset?.status() !== 200 || new URL(asset.url()).origin !== origin) throw Error("document-unavailable");
  const response = await page.request.get(new URL("/api/version", origin).href, { maxRedirects: 0, timeout: 5000 });
  if (response.status() !== 200) throw Error("origin-version-unavailable");
  return verifyWebCanary({
    expected,
    asset: { worker: asset.headers()["x-s3rch-worker-version"], bytes: await asset.body() },
    origin: { worker: response.headers()["x-s3rch-worker-version"], revision: (await response.json()).revision },
  });
}
