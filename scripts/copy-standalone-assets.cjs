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
copy(path.join(__dirname, "..", "gun-preload.cjs"), path.join(standalone, "gun-preload.cjs"));
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
  outfile: path.join(standalone, "seed-peer.cjs"),
  platform: "node", target: "node24", bundle: true, packages: "external",
});

// Gun loads its Node WebCrypto provider dynamically. Trace that entry and
// its dependencies the same way Next traces statically imported packages.
async function copySeaProvider() {
  const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft");
  const root = path.resolve(__dirname, "..");
  const { fileList } = await nodeFileTrace([require.resolve("@peculiar/webcrypto")], { base: root });
  for (const file of fileList) {
    if (!file.startsWith("node_modules/")) throw Error("Unexpected SEA dependency path: " + file);
    const dest = path.join(standalone, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, file), dest);
  }
}
copySeaProvider().catch(error => { console.error(error); process.exitCode = 1; });
