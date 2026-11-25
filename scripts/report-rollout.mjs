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

async function github(path, body) {
  const token = process.env.GH_TOKEN;
  if (!token) throw Error("Rollout issue token is unavailable");
  const response = await fetch("https://api.github.com/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw Error("GitHub issue operation failed (" + response.status + ")");
  return response.json();
}

export async function rolloutIssue(env, api = github) {
  const scope = env.ROLLOUT_ENV ?? "test";
  const tag = env.GITHUB_REF_NAME ?? "";
  const candidate = scope === "production" ? env.CANDIDATE_REVISION ?? "" : env.GITHUB_SHA ?? "";
  const restored = env.RESTORED_REVISION ?? "";
  const run = env.GITHUB_RUN_ID ?? "";
  if (!["test", "production"].includes(scope) || env.GITHUB_REPOSITORY !== repo ||
      (scope === "production" && !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag)) ||
      !sha.test(candidate) || !sha.test(restored) || candidate === restored ||
      !/^[1-9][0-9]{0,18}$/.test(run)) throw Error("Unverified rollout context");
  const marker = "<!-- s3rch-" + scope + "-rollout:" + candidate + " -->";
  const endpoint = "repos/" + repo + "/issues";
  const existing = [];
  for (let page = 1; ; page++) {
    const rows = await api(endpoint + "?state=all&per_page=100&page=" + page);
    if (!Array.isArray(rows)) throw Error("GitHub issue inventory unavailable");
    existing.push(...rows.filter(row => !row.pull_request && row.body?.includes(marker)));
    if (rows.length < 100) break;
  }
  if (existing.length > 1) throw Error("Multiple issues already claim the same rollout");
  if (existing.length === 1) return existing[0].html_url;

  let startup;
  try { startup = JSON.parse(env.STARTUP_DIAGNOSTICS ?? "{}"); } catch { startup = {}; }
  const observed = startup?.revision === candidate && startup.observed === true && Array.isArray(startup.missing);
  const missing = observed ? [...new Set(startup.missing.filter(name => knownSettings.has(name)))].sort((a, b) => a.localeCompare(b)) : [];
  const startupLine = observed
    ? (missing.length ? missing.map(name => "- " + name).join("\n") : "No missing startup settings were reported.")
    : "Startup settings were unavailable for this candidate.";
  const squad = startup?.revision === candidate && ["available", "missing", "denied", "unavailable"].includes(startup.squad_key)
    ? "\n\nSquad statement key status: " + startup.squad_key + "." : "";
  const body = [
    "Deployment verification failed. The previous " + scope + " revision was restored and verified.",
    "- Candidate: " + candidate + "\n- Restored: " + restored + "\n- [Deployment run](https://github.com/" + repo + "/actions/runs/" + run + ")",
    "### Startup configuration\n\n" + startupLine + squad, marker,
  ].join("\n\n");
  const label = scope === "production" ? "production " + tag : "TEST " + candidate.slice(0, 12);
  const created = await api(endpoint, { title: "s3r.ch rolled back " + label, body });
  return created.html_url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await rolloutIssue(process.env));
}
