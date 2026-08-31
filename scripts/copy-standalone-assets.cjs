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
copy(path.join(__dirname, "..", "gun-preload.cjs"), path.join(standalone, "gun-preload.cjs"));
console.log("[s3r.ch] standalone assets copied");
