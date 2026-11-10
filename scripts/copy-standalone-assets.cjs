const fs = require("node:fs");
const path = require("node:path");

const standalone = path.join(__dirname, "..", ".next", "standalone");
if (!fs.existsSync(standalone)) {
  console.warn("[s3r.ch] standalone output missing; skip asset copy");
  process.exit(0);
}

function copy(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true });
}

copy(path.join(__dirname, "..", ".next", "static"), path.join(standalone, ".next", "static"));
copy(path.join(__dirname, "..", "public"), path.join(standalone, "public"));
copy(path.join(standalone, "public/feed-cache/empty.json"), path.join(standalone, "public/feed-cache/snapshot.json"));
copy(path.join(__dirname, "..", "public-feed-cache.cjs"), path.join(standalone, "public-feed-cache.cjs"));
copy(path.join(__dirname, "..", "identity-storage.cjs"), path.join(standalone, "identity-storage.cjs"));
copy(path.join(__dirname, "..", "identity-link-schema.cjs"), path.join(standalone, "identity-link-schema.cjs"));
copy(path.join(__dirname, "..", "identity-blob.cjs"), path.join(standalone, "identity-blob.cjs"));
copy(path.join(__dirname, "..", "identity-blob-worker.cjs"), path.join(standalone, "identity-blob-worker.cjs"));
copy(path.join(__dirname, "..", "identity-health.cjs"), path.join(standalone, "identity-health.cjs"));
copy(path.join(__dirname, "..", "identity-monitor.cjs"), path.join(standalone, "identity-monitor.cjs"));
copy(path.join(__dirname, "..", "identity-probe-worker.cjs"), path.join(standalone, "identity-probe-worker.cjs"));
console.log("[s3r.ch] standalone assets copied");

// The same image can run the bootstrap peer without loading Next or identity.
require("esbuild").buildSync({
  entryPoints: [path.join(__dirname, "seed-peer.ts")],
  outfile: path.join(__dirname, "..", ".next", "seed-peer.cjs"),
  platform: "node", target: "node24", bundle: true, packages: "external",
});

// Gun SEA dynamically loads its text encoder and Node WebCrypto provider.
// Trace both entries explicitly; the peer graph alone does not reveal them.
async function copyPeerDependencies() {
  const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft");
  const root = path.resolve(__dirname, "..");
  const { fileList } = await nodeFileTrace([require.resolve("@peculiar/webcrypto"), require.resolve("gun/lib/text-encoding"), path.join(root, ".next", "seed-peer.cjs")], { base: root });
  for (const file of fileList) {
    if (file === ".next/seed-peer.cjs") continue;
    if (!file.startsWith("node_modules/")) throw Error("Unexpected SEA dependency path: " + file);
    const dest = path.join(standalone, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, file), dest);
  }
}
copy(path.join(__dirname, "..", ".next", "seed-peer.cjs"), path.join(standalone, "seed-peer.cjs"));
copyPeerDependencies().catch(error => { console.error(error); process.exitCode = 1; });
