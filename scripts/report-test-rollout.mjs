import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repo = "FyberLabs/s3r.ch";
const sha = /^[0-9a-f]{40}$/;
const knownSettings = new Set([
  "APP_BUILD_REVISION", "AZURE_CLIENT_ID", "IDENTITY_SESSION_SECRET",
  "S3RCH_IDENTITY_BLOB_ACCOUNT", "S3RCH_IDENTITY_BLOB_CONTAINER", "S3RCH_SQUAD_PILOT",
  "S3RCH_STARTUP_LOGIN_PROVIDER", "S3RCH_STARTUP_AUTH_URL",
  "S3RCH_STATEMENT_SOURCE_API_KEY", "S3RCH_STATEMENT_SOURCE_ORIGIN",
  "S3RCH_STATEMENT_SOURCE_TENANT_ID", "S3RCH_STATEMENT_SOURCE_SCOPE",
]);

function github(args, input) {
  const result = spawnSync("gh", ["api", ...args], { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw Error("GitHub operation failed");
  return JSON.parse(result.stdout);
}

export function rolloutIssue(env, api = github) {
  const candidate = env.GITHUB_SHA ?? "";
  const restored = env.RESTORED_REVISION ?? "";
  const run = env.GITHUB_RUN_ID ?? "";
  if (env.GITHUB_REPOSITORY !== repo || !sha.test(candidate) || !sha.test(restored) ||
      candidate === restored || !/^[1-9][0-9]{0,18}$/.test(run)) throw Error("Unverified TEST rollback context");
  const marker = "<!-- s3rch-test-rollout:" + candidate + " -->";
  const endpoint = "repos/" + repo + "/issues";
  const existing = api(["--paginate", "--slurp", endpoint + "?state=all&per_page=100"])
    .flat().filter(row => !row.pull_request && row.body?.includes(marker));
  if (existing.length > 1) throw Error("Multiple TEST issues already claim the same candidate");
  if (existing.length === 1) return existing[0].html_url;

  let startup;
  try { startup = JSON.parse(env.STARTUP_DIAGNOSTICS ?? "{}"); } catch { startup = {}; }
  const observed = startup?.revision === candidate && startup.observed === true && Array.isArray(startup.missing);
  const missing = observed ? [...new Set(startup.missing.filter(name => knownSettings.has(name)))].sort() : [];
  const startupLine = observed
    ? (missing.length ? missing.map(name => "- " + name).join("\n") : "No missing startup settings were reported.")
    : "Startup settings were unavailable for this candidate.";
  const squad = startup?.revision === candidate && ["available", "missing", "denied", "unavailable"].includes(startup.squad_key)
    ? "\n\nSquad statement key status: " + startup.squad_key + "." : "";
  const body = [
    "The TEST channel failed deployment verification. The previous revision was restored and verified.",
    "- Candidate: " + candidate + "\n- Restored: " + restored + "\n- [Deployment run](https://github.com/" + repo + "/actions/runs/" + run + ")",
    "### Startup configuration\n\n" + startupLine + squad, marker,
  ].join("\n\n");
  const created = api(["-X", "POST", endpoint, "--input", "-"], JSON.stringify({
    title: "s3r.ch TEST rolled back " + candidate.slice(0, 12), body,
  }));
  return created.html_url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(rolloutIssue(process.env));
}
