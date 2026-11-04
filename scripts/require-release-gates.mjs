/**
 * Stop a tag publish unless the tag commit is on the protected default branch
 * and this checkout matches
 * the release scripts on that branch.
 */
import { execFileSync } from "node:child_process";

export const TRUSTED_RELEASE_FILES = [
  "scripts/release-channels.mjs",
  "scripts/require-release-gates.mjs",
  "scripts/publish-version-tag.mjs",
  "scripts/advance-release-aliases.mjs",
  "scripts/ghcr-image-version.mjs",
  "scripts/release-aliases.mjs",
  "scripts/version-tag-plan.mjs",
  "scripts/require-anonymous-pull.sh",
  "scripts/smoke-image.sh",
  "scripts/startup-packages.mjs",
  "scripts/publish-github-release.sh",
];

export function trustedTreeErrors(checks) {
  const errors = [];
  for (const check of checks) {
    if (!check.present) errors.push(`${check.path} is not on the default branch.`);
    else if (!check.same) errors.push(`${check.path} does not match the default branch.`);
  }
  return errors;
}

export function gateErrors(branch) {
  const errors = [];
  const name = branch?.name || "default branch";
  if (!branch?.protected) {
    errors.push(`Branch ${name} is not protected.`);
  }
  return errors;
}

function gh(path) {
  let out;
  try {
    out = execFileSync("gh", ["api", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = String(error.stderr || error.message || "").trim();
    throw new Error(`GitHub API ${path} failed: ${detail}`);
  }
  return JSON.parse(out);
}

function fetchBranch(branch) {
  execFileSync(
    "git",
    ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    { stdio: "inherit" },
  );
}

function trustedChecks(branch) {
  return TRUSTED_RELEASE_FILES.map((file) => {
    let present = true;
    try {
      execFileSync("git", ["cat-file", "-e", `origin/${branch}:${file}`], { stdio: "ignore" });
    } catch {
      present = false;
    }
    let same = false;
    if (present) {
      try {
        execFileSync("git", ["diff", "--quiet", `origin/${branch}`, "--", file], { stdio: "ignore" });
        same = true;
      } catch (error) {
        if (error.status !== 1) throw error;
      }
    }
    return { path: file, present, same };
  });
}

function onDefaultBranch(sha, branch) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, `origin/${branch}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (!repo || !/^[0-9a-f]{40}$/.test(sha || "")) {
    console.error("GITHUB_REPOSITORY and GITHUB_SHA are required.");
    process.exit(1);
  }
  const repository = gh(`repos/${repo}`);
  const branchName = repository.default_branch;
  if (!/^[A-Za-z0-9._/-]+$/.test(branchName || "")) {
    console.error("Unexpected default branch name.");
    process.exit(1);
  }
  fetchBranch(branchName);
  const errors = trustedTreeErrors(trustedChecks(branchName));
  const branch = gh(`repos/${repo}/branches/${branchName}`);
  errors.push(...gateErrors(branch));
  if (!onDefaultBranch(sha, branchName)) {
    errors.push(`Tag commit ${sha} is not on ${branchName}.`);
  }
  if (errors.length) {
    for (const error of errors) console.error(error);
    console.error("Refusing to build or push this tag.");
    process.exit(1);
  }
  console.log(`Release gates passed for ${sha} on protected ${branchName}.`);
}

if (process.argv[1] && process.argv[1].endsWith("require-release-gates.mjs")) {
  main();
}
