import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { verifyContract, validateLock } from "./check-sociacl-contract.mjs";

const bytes = Buffer.from("export type Principal = string;\n");
const lock = { repository: "FyberLabs/SociACL", revision: "a".repeat(40), path: "docs/s3rch-check.d.ts",
  sha256: createHash("sha256").update(bytes).digest("hex") };

test("accepts exact upstream bytes", () => verifyContract(bytes, lock, Buffer.from(bytes)));
test("rejects local edits including line-ending conversion", () => {
  for (const changed of [Buffer.from("changed"), Buffer.from(bytes.toString().replace(/\n/g, "\r\n"))]) {
    assert.throws(() => verifyContract(changed, lock), /recorded SHA-256/);
  }
});
test("a changed lock hash cannot hide upstream drift", () => {
  const changed = Buffer.from("local replacement");
  const changedLock = { ...lock, sha256: createHash("sha256").update(changed).digest("hex") };
  assert.throws(() => verifyContract(changed, changedLock, bytes), /pinned upstream bytes/);
});
test("rejects moving references and alternative provenance", () => {
  for (const patch of [{ revision: "master" }, { revision: "../master" }, { sha256: "invalid" },
    { repository: "other/repo" }, { path: "../contract" }, { extra: true }]) {
    assert.throws(() => validateLock({ ...lock, ...patch }), /Invalid/);
  }
});
