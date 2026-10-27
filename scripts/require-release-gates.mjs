/**
 * Stop a tag publish unless a reviewer must approve the release environment
 * and the tag commit is on the protected default branch.
 */
import { execFileSync } from "node:child_process";

const ENVIRONMENT = "release";

export function reviewerCount(environment) {
  const rules = Array.isArray(environment?.protection_rules) ? environment.protection_rules : [];
  const rule = rules.find((item) => item?.type === "required_reviewers");
  return Array.isArray(rule?.reviewers) ? rule.reviewers.length : 0;
}

export function gateErrors(environment, branch) {
  const errors = [];
  if (reviewerCount(environment) < 1) {
    errors.push(
      `GitHub environment "${ENVIRONMENT}" must require at least one reviewer before a tag can publish.`,
    );
  }
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

function onDefaultBranch(sha, branch) {
  execFileSync(
    "git",
    ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    { stdio: "inherit" },
  );
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, `origin/${branch}`], {
      stdio: "inherit",
    });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (!repo || !sha) {
    console.error("GITHUB_REPOSITORY and GITHUB_SHA are required.");
    process.exit(1);
  }
  const repository = gh(`repos/${repo}`);
  const branchName = repository.default_branch;
  if (!/^[A-Za-z0-9._/-]+$/.test(branchName || "")) {
    console.error("Unexpected default branch name.");
    process.exit(1);
  }
  let environment;
  try {
    environment = gh(`repos/${repo}/environments/${ENVIRONMENT}`);
  } catch (error) {
    console.error(error.message);
    console.error(
      `The "${ENVIRONMENT}" environment must exist and require at least one reviewer.`,
    );
    process.exit(1);
  }
  const branch = gh(`repos/${repo}/branches/${branchName}`);
  const errors = gateErrors(environment, branch);
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
