import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { verifyContract, validateLock } from "./check-sociacl-contract.mjs";

const bytes = Buffer.from("upstream bytes\n");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const files = [
  { source: "docs/s3rch-check.d.ts", path: "docs/s3rch-check.d.ts", sha256 },
  { source: "vectors/mesh/forums.json", path: "lib/identity/vectors/forums.json", sha256 },
  { source: "vectors/ids/principal.json", path: "lib/identity/vectors/principal.json", sha256 },
];
const lock = { repository: "FyberLabs/SociACL", revision: "a".repeat(40), files };

for (const file of files) {
  test(`${file.source}: accepts exact upstream bytes`, () => verifyContract(bytes, file, Buffer.from(bytes)));
  test(`${file.source}: rejects local edits including line endings`, () => {
    for (const changed of [Buffer.from("changed"), Buffer.from(bytes.toString().replace(/\n/g, "\r\n"))]) {
      assert.throws(() => verifyContract(changed, file), /recorded SHA-256/);
    }
  });
  test(`${file.source}: changing the hash cannot hide upstream drift`, () => {
    const changed = Buffer.from("local replacement");
    const changedFile = { ...file, sha256: createHash("sha256").update(changed).digest("hex") };
    assert.throws(() => verifyContract(changed, changedFile, bytes), /pinned upstream bytes/);
  });
}
test("requires every expected artifact exactly once", () => {
  assert.equal(validateLock(lock), lock);
  for (const changed of [files.slice(0, 2), [files[0], files[1], files[1]], [...files, files[0]]]) {
    assert.throws(() => validateLock({ ...lock, files: changed }), /Invalid/);
  }
});
test("rejects moving references and alternative provenance", () => {
  for (const patch of [{ revision: "master" }, { revision: "../master" }, { repository: "other/repo" }, { extra: true }]) {
    assert.throws(() => validateLock({ ...lock, ...patch }), /Invalid/);
  }
  for (const patch of [{ sha256: "invalid" }, { path: "../contract" }, { source: "vectors/other.json" }, { extra: true }]) {
    assert.throws(() => validateLock({ ...lock, files: [{ ...files[0], ...patch }, ...files.slice(1)] }), /Invalid/);
  }
});
