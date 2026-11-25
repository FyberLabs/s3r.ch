import test from "node:test";
import assert from "node:assert/strict";
import { rolloutIssue } from "./report-rollout.mjs";

const candidate = "a".repeat(40);
const restored = "b".repeat(40);
const base = {
  GITHUB_REPOSITORY: "FyberLabs/s3r.ch",
  GITHUB_SHA: candidate,
  RESTORED_REVISION: restored,
  GITHUB_RUN_ID: "111",
  STARTUP_DIAGNOSTICS: JSON.stringify({
    revision: candidate, observed: true, missing: ["IDENTITY_SESSION_SECRET", "PRIVATE_VALUE"], squad_key: "missing",
  }),
};

test("a verified rollback creates one issue and repeats find the same issue", async () => {
  const rows = [];
  const api = async (path, issue) => {
    assert.match(path, /^repos\/FyberLabs\/s3r\.ch\/issues/);
    if (!issue) return rows;
    assert.match(issue.body, /IDENTITY_SESSION_SECRET/);
    assert.match(issue.body, /Squad statement key status: missing/);
    assert.doesNotMatch(issue.body, /PRIVATE_VALUE/);
    const row = { html_url: "https://github.com/FyberLabs/s3r.ch/issues/123", body: issue.body };
    rows.push(row);
    return row;
  };
  assert.equal(await rolloutIssue(base, api), await rolloutIssue(base, api));
  assert.equal(rows.length, 1);
});

test("refuse unverified rollbacks and separate production issue markers", async () => {
  await assert.rejects(rolloutIssue({ ...base, RESTORED_REVISION: "" }), /Unverified/);
  await assert.rejects(rolloutIssue({ ...base, ROLLOUT_ENV: "production", CANDIDATE_REVISION: candidate }), /Unverified/);
  const api = async (_, issue) => {
    if (!issue) return [];
    assert.match(issue.title, /production v0\.1\.299/);
    assert.match(issue.body, /s3rch-production-rollout/);
    return { html_url: "https://github.com/FyberLabs/s3r.ch/issues/123" };
  };
  await rolloutIssue({ ...base, ROLLOUT_ENV: "production", CANDIDATE_REVISION: candidate, GITHUB_REF_NAME: "v0.1.299" }, api);
});
