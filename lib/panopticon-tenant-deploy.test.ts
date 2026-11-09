import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../scripts/require-panopticon-tenant-id.sh", import.meta.url),
);
const SAMPLE = "11111111-2222-4333-8444-555555555555";

function runRequire(
  value: string | undefined,
  opts?: { githubActions?: boolean; outPath?: string },
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (value === undefined) delete env.S3RCH_PANOPTICON_TENANT_ID;
  else env.S3RCH_PANOPTICON_TENANT_ID = value;
  env.GITHUB_ACTIONS = opts?.githubActions ? "true" : "";
  return spawnSync("bash", [SCRIPT, ...(opts?.outPath ? [opts.outPath] : [])], {
    encoding: "utf8",
    env,
  });
}

describe("require-panopticon-tenant-id", () => {
  it("fails when the GitHub variable is unset and writes no id file", () => {
    const dir = mkdtempSync(join(tmpdir(), "panopticon-tenant-"));
    const outPath = join(dir, "id");
    try {
      const result = runRequire(undefined, { outPath });
      assert.notEqual(result.status, 0);
      const text = `${result.stdout}${result.stderr}`;
      assert.match(text, /S3RCH_PANOPTICON_TENANT_ID is unset/);
      assert.match(text, /repository variable or a prod environment variable/);
      assert.match(text, /PANOPTICON_TENANT_ID is not cleared/);
      assert.equal(result.stdout, "");
      assert.equal(existsSync(outPath), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when the variable is blank", () => {
    const result = runRequire("  \n");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /is unset/);
    assert.equal(result.stdout, "");
  });

  it("fails on a non-UUID without echoing it", () => {
    const bad = "not-a-tenant";
    const result = runRequire(bad);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /is not a UUID/);
    assert.equal(`${result.stdout}${result.stderr}`.includes(bad), false);
  });

  it("accepts a UUID and writes it only to the requested file", () => {
    const dir = mkdtempSync(join(tmpdir(), "panopticon-tenant-"));
    const outPath = join(dir, "id");
    try {
      const result = runRequire(`  ${SAMPLE}\n`, { outPath });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.equal(readFileSync(outPath, "utf8"), SAMPLE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("masks the value for Actions logs without leaving it on stderr", () => {
    const result = runRequire(SAMPLE, { githubActions: true });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `::add-mask::${SAMPLE}\n`);
    assert.equal(result.stderr, "");
  });
});

describe("merge deployment is isolated from production tenant settings", () => {
  const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  const deploy = readFileSync(new URL("../scripts/deploy-test.sh", import.meta.url), "utf8");
  it("targets only test and never writes production marketplace credentials", () => {
    assert.match(workflow, /environment: test/);
    assert.match(deploy, /web=s3rch-fyberlabs-test/);
    assert.match(deploy, /peer=s3rch-fyberlabs-peer-test/);
    assert.doesNotMatch(deploy, /appsettings set|PANOPTICON_TENANT_ID|(?:app|web|peer)=s3rch-fyberlabs-prod/);
    assert.doesNotMatch(workflow, /environment: prod|S3RCH_PANOPTICON_TENANT_ID/);
  });
});
