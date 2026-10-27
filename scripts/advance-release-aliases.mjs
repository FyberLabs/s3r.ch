/**
 * Point X.Y and latest at this image only when this version is not older
 * than the version those tags already have.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fetchTagVersion, imageForRepository } from "./ghcr-image-version.mjs";
import { shouldAdvanceAlias } from "./release-aliases.mjs";

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

function pushAlias(localTag, image, alias) {
  execFileSync("docker", ["tag", localTag, `${image}:${alias}`], { stdio: "inherit" });
  execFileSync("docker", ["push", `${image}:${alias}`], { stdio: "inherit" });
}

async function move(image, alias, version, localTag) {
  const current = await fetchTagVersion(image, alias);
  if (!shouldAdvanceAlias(current, version)) {
    console.log(`Leaving ${image}:${alias} at ${current}. ${version} is older.`);
    return "no";
  }
  const from = current ?? "absent";
  console.log(`Moving ${image}:${alias} from ${from} to ${version}.`);
  pushAlias(localTag, image, alias);
  return "yes";
}

const image = process.env.IMAGE ?? "";
const version = process.env.VERSION ?? "";
const minor = process.env.MINOR ?? "";
const localTag = process.env.LOCAL_TAG || "s3rch:release";
const expected = imageForRepository(process.env.GITHUB_REPOSITORY);

if (!expected || image !== expected || !SEMVER.test(version) || !SEMVER.test(`${minor}.0`)) {
  console.error("IMAGE, VERSION, MINOR, and GITHUB_REPOSITORY are required.");
  process.exit(1);
}
if (localTag !== "s3rch:release" && localTag !== "s3rch:published") {
  console.error("LOCAL_TAG is not a release image.");
  process.exit(1);
}
if (process.env.REUSED === "yes" && localTag !== "s3rch:published") {
  console.error("Refusing to move aliases from the rebuild when the version tag was reused.");
  process.exit(1);
}
if (version.slice(0, minor.length + 1) !== `${minor}.`) {
  console.error(`${version} is not in the ${minor} line.`);
  process.exit(1);
}

const minorMoved = await move(image, minor, version, localTag);
const latestMoved = await move(image, "latest", version, localTag);
output("minor_moved", minorMoved);
output("latest_moved", latestMoved);
