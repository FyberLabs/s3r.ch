/**
 * Push IMAGE:VERSION only when that tag is absent.
 * When it is already published with this version label, reuse its digest.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fetchTagRelease, imageForRepository } from "./ghcr-image-version.mjs";
import { versionTagPlan } from "./version-tag-plan.mjs";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function output(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const line = `${name}=${value}\n`;
  if (!file) {
    process.stdout.write(line);
    return;
  }
  fs.appendFileSync(file, line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const image = process.env.IMAGE ?? "";
const version = process.env.VERSION ?? "";
const localBuild = process.env.LOCAL_TAG || "s3rch:release";
const githubToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const actor = process.env.GITHUB_ACTOR || "";
const expected = imageForRepository(process.env.GITHUB_REPOSITORY);

if (!expected || image !== expected || !SEMVER.test(version) || localBuild !== "s3rch:release") {
  console.error("IMAGE, VERSION, LOCAL_TAG, and GITHUB_REPOSITORY are required.");
  process.exit(1);
}
if (!githubToken) {
  console.error("GH_TOKEN is required so an existing private tag is not treated as missing.");
  process.exit(1);
}

let existing;
try {
  existing = await fetchTagRelease(image, version, { githubToken, actor });
} catch (error) {
  console.error(error.message);
  console.error("Refusing to push because the existing version tag could not be read.");
  process.exit(1);
}

let plan;
try {
  plan = versionTagPlan(existing, version);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (plan.action === "reuse") {
  console.log(`Reusing ${image}:${version}@${plan.digest}. Not pushing a new image.`);
  execFileSync("docker", ["pull", `${image}@${plan.digest}`], { stdio: "inherit" });
  execFileSync("docker", ["tag", `${image}@${plan.digest}`, "s3rch:published"], { stdio: "inherit" });
  output("digest", plan.digest);
  output("reused", "yes");
  output("local_tag", "s3rch:published");
} else {
  execFileSync("docker", ["tag", localBuild, `${image}:${version}`], { stdio: "inherit" });
  execFileSync("docker", ["push", `${image}:${version}`], { stdio: "inherit" });
  let published = null;
  let lastError = new Error(`GHCR tag ${version} was not readable after push`);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      published = await fetchTagRelease(image, version, { githubToken, actor });
      if (published) break;
      lastError = new Error(`GHCR tag ${version} is not visible yet`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 5) await sleep(3000);
  }
  let pushed;
  try {
    pushed = versionTagPlan(published, version);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (pushed.action !== "reuse") {
    console.error(lastError.message);
    process.exit(1);
  }
  console.log(`Pushed ${image}@${pushed.digest}`);
  output("digest", pushed.digest);
  output("reused", "no");
  output("local_tag", localBuild);
}
