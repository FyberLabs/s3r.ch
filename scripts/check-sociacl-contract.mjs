import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const sources = new Map([
  ["lib/identity/vectors/object.json", "vectors/ids/object.json"],
  ["docs/s3rch-check.d.ts", "docs/s3rch-check.d.ts"],
  ["lib/identity/vectors/forums.json", "vectors/mesh/forums.json"],
  ["lib/identity/vectors/principal.json", "vectors/ids/principal.json"],
]);

function validateFile(file) {
  if (!file || Object.keys(file).sort().join() !== "path,sha256,source" ||
      !sources.has(file.path) || sources.get(file.path) !== file.source ||
      typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) {
    throw Error("Invalid SociACL artifact provenance");
  }
}

export function validateLock(lock) {
  if (!lock || Object.keys(lock).sort().join() !== "files,repository,revision" ||
      lock.repository !== "FyberLabs/SociACL" || typeof lock.revision !== "string" ||
      !/^[0-9a-f]{40}$/.test(lock.revision) || !Array.isArray(lock.files) || lock.files.length !== sources.size) {
    throw Error("Invalid SociACL contract provenance");
  }
  const seen = new Set();
  for (const file of lock.files) {
    validateFile(file);
    if (seen.has(file.path)) throw Error("Invalid duplicate SociACL artifact");
    seen.add(file.path);
  }
  return lock;
}

export function verifyContract(bytes, file, upstream) {
  validateFile(file);
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
    throw Error(`${file.path} differs from its recorded SHA-256; sync from upstream, do not edit the copy`);
  }
  if (upstream !== undefined && !bytes.equals(upstream)) {
    throw Error(`${file.path} differs from the pinned upstream bytes`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--upstream")) {
    throw Error("Usage: node scripts/check-sociacl-contract.mjs [--upstream]");
  }
  const root = new URL("../", import.meta.url);
  const lock = validateLock(JSON.parse(await readFile(new URL("docs/sociacl-contract.json", root), "utf8")));
  for (const file of lock.files) {
    const bytes = await readFile(new URL(file.path, root));
    verifyContract(bytes, file);
    if (args.includes("--upstream")) {
      const url = `https://raw.githubusercontent.com/${lock.repository}/${lock.revision}/${file.source}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: "error" });
      if (!response.ok) throw Error(`Cannot verify SociACL upstream ${file.source}: HTTP ${response.status}`);
      verifyContract(bytes, file, Buffer.from(await response.arrayBuffer()));
    }
    console.log(`SociACL ${file.path} verified at ${lock.revision}${args.length ? " against upstream" : " (local SHA-256)"}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
