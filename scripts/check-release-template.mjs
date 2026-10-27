/**
 * The GitHub Release body is this file plus the image digest.
 * Both sections must stay so a tag cannot ship without them.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github",
  "RELEASE_TEMPLATE.md",
);
const text = fs.readFileSync(file, "utf8");
const required = ["## Config changes", "## Migration"];
const missing = required.filter((heading) => !text.includes(heading));
if (missing.length) {
  console.error(`Release notes template is missing: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("release notes template ok");
