import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  it("fails when the GitHub variable is unset and does not print a value", () => {
    const result = runRequire(undefined);
    assert.notEqual(result.status, 0);
    const text = `${result.stdout}${result.stderr}`;
    assert.match(text, /S3RCH_PANOPTICON_TENANT_ID is unset/);
    assert.match(text, /repository variable or a prod environment variable/);
    assert.match(text, /PANOPTICON_TENANT_ID is not cleared/);
    assert.equal(result.stdout, "");
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

describe("deploy workflow owns PANOPTICON_TENANT_ID", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy.yml", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("reads the repo variable and sets only that App Service setting", () => {
    assert.match(workflow, /S3RCH_PANOPTICON_TENANT_ID: \$\{\{ vars\.S3RCH_PANOPTICON_TENANT_ID \}\}/);
    assert.match(workflow, /bash scripts\/require-panopticon-tenant-id\.sh/);
    assert.match(workflow, /PANOPTICON_TENANT_ID=\$\{tenant_id\}/);
    assert.equal(
      /PANOPTICON_TENANT_ID[:=]\s*["']?[0-9a-fA-F]{8}-/.test(workflow),
      false,
    );
  });

  it("preflights a missing tenant id before checkout and image push", () => {
    const deploy = workflow.slice(workflow.indexOf("\n  deploy:\n"));
    const preflight = deploy.indexOf("name: Require Panopticon tenant id");
    const checkout = deploy.indexOf("actions/checkout@");
    const push = deploy.indexOf("docker/build-push-action@");
    const scriptStep = deploy.indexOf("bash scripts/require-panopticon-tenant-id.sh\n");
    assert.ok(preflight >= 0 && preflight < checkout && checkout < scriptStep && scriptStep < push);
    assert.match(deploy.slice(0, checkout), /repository variable or a prod environment variable/);
    assert.match(deploy.slice(0, checkout), /PANOPTICON_TENANT_ID is not cleared/);
    const script = readFileSync(SCRIPT, "utf8");
    const uuidPattern =
      "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
    assert.equal(script.includes(uuidPattern), true);
    assert.equal(deploy.slice(0, checkout).includes(uuidPattern), false);
  });

  it("skips Azure logout when the job never signed in", () => {
    const deploy = workflow.slice(workflow.indexOf("\n  deploy:\n"));
    const logout = deploy.slice(deploy.indexOf("name: Log out of Azure and ACR"));
    assert.match(logout, /az account show >\/dev\/null 2>&1/);
    assert.match(logout, /\[ -d "\$AZURE_CONFIG_DIR" \] && az account show/);
  });

  it("documents the tenant id with the other deploy variables", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    for (const name of [
      "ACR_NAME",
      "ACR_LOGIN_SERVER",
      "SEED_URL",
      "NEXT_PUBLIC_WC_PROJECT_ID",
      "S3RCH_PANOPTICON_TENANT_ID",
    ]) {
      assert.equal(readme.includes(name), true, name);
    }
    assert.match(
      readme,
      /Panopticon marketplace tenant id the app uses, set as `PANOPTICON_TENANT_ID` on the App Service; it is an identifier, not a secret/,
    );
  });

  it("stays on the self-hosted deploy runner and does not run for pull requests", () => {
    assert.match(workflow, /push:\s*\n\s*branches: \[master\]/);
    assert.match(workflow, /workflow_dispatch:/);
    assert.equal(workflow.includes("pull_request:"), false);
    assert.match(workflow, /runs-on: \[self-hosted, linux, x64\]/);
  });
});
