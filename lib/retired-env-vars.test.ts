import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { collectReads } from "../scripts/check-config-reference.mjs";

const retired = [
  "IDENTITY_SESSION_SECRET",
  "S3RCH_SQUAD_PILOT",
  "S3RCH_STATEMENT_SOURCE_API_KEY",
  "S3RCH_IDENTITY_REPLAY_API_KEY",
  "S3RCH_FORUM_AUTHORITY",
  "S3RCH_DELEGATION_SOURCE_API_KEY",
];

test("retired deployment settings are not read by application code", () => {
  const reads = collectReads();
  for (const name of retired) {
    const sites = reads.get(name);
    assert.equal(sites, undefined, `${name} still read in ${sites?.join(", ")}`);
  }
});

test("service credential module names the consolidated secret", () => {
  const text = readFileSync(new URL("./acl-statement-source-server.ts", import.meta.url), "utf8");
  assert.match(text, /S3RCH_SERVICE_CREDENTIAL/);
  assert.doesNotMatch(text, /S3RCH_STATEMENT_SOURCE_API_KEY|S3RCH_IDENTITY_REPLAY_API_KEY/);
});