/**
 * Test double for one identity blob. A directory is the stand-in so two
 * processes can share it. Production uses the Azure client.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blobConflict, type IdentityBlobClient } from "../../identity-blob.cjs";

export function directoryBlobClient(dir: string): IdentityBlobClient {
  const body = join(dir, "blob.json");
  const etagFile = join(dir, "etag");
  const lock = join(dir, ".writer");
  return {
    assertReachable() {},
    download() {
      if (!existsSync(body)) return { found: false };
      return { found: true, text: readFileSync(body, "utf8"), etag: readFileSync(etagFile, "utf8") };
    },
    upload(_blobName, text, conditions) {
      mkdirSync(lock);
      try {
        const exists = existsSync(body);
        const current = exists ? readFileSync(etagFile, "utf8") : "";
        if (conditions.ifNoneMatch === "*" && exists) throw blobConflict();
        if (conditions.ifMatch !== undefined && conditions.ifMatch !== current) throw blobConflict();
        const next = String((Number(current) || 0) + 1);
        const tmp = join(dir, `body.${process.pid}.tmp`);
        writeFileSync(tmp, text, { mode: 0o600 });
        renameSync(tmp, body);
        writeFileSync(etagFile, next, { mode: 0o600 });
        return { etag: next };
      } finally {
        rmdirSync(lock);
      }
    },
  };
}
