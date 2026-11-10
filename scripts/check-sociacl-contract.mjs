import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function validateLock(lock) {
  if (!lock || Object.keys(lock).sort().join() !== "path,repository,revision,sha256" ||
      lock.repository !== "FyberLabs/SociACL" || lock.path !== "docs/s3rch-check.d.ts" ||
      !/^[0-9a-f]{40}$/.test(lock.revision) || !/^[0-9a-f]{64}$/.test(lock.sha256)) {
    throw Error("Invalid SociACL contract provenance");
  }
  return lock;
}

export function verifyContract(bytes, lock, upstream) {
  validateLock(lock);
  if (createHash("sha256").update(bytes).digest("hex") !== lock.sha256) {
    throw Error("SociACL contract differs from its recorded SHA-256; sync from upstream, do not edit the copy");
  }
  if (upstream !== undefined && !bytes.equals(upstream)) {
    throw Error("SociACL contract differs from the pinned upstream bytes");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--upstream")) {
    throw Error("Usage: node scripts/check-sociacl-contract.mjs [--upstream]");
  }
  const root = new URL("../", import.meta.url);
  const lock = validateLock(JSON.parse(await readFile(new URL("docs/sociacl-contract.json", root), "utf8")));
  const bytes = await readFile(new URL(lock.path, root));
  verifyContract(bytes, lock);
  if (args.includes("--upstream")) {
    const url = `https://raw.githubusercontent.com/${lock.repository}/${lock.revision}/${lock.path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: "error" });
    if (!response.ok) throw Error(`Cannot verify SociACL upstream: HTTP ${response.status}`);
    verifyContract(bytes, lock, Buffer.from(await response.arrayBuffer()));
  }
  console.log(`SociACL contract verified at ${lock.revision}${args.length ? " against upstream" : " (local SHA-256)"}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
