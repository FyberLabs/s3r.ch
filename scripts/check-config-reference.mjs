/**
 * Fail when server or deploy code reads an S3RCH_*, PANOPTICON_*, or GUN_*
 * setting that docs/configuration.md does not list, or when that doc lists
 * a setting the scanned code does not read.
 *
 * TypeScript and CommonJS: property reads and quoted names only, so graph
 * constants such as S3RCH_ROOT are not settings.
 * Shell, Python, and workflow YAML: any whole-word name.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC = path.join(ROOT, "docs", "configuration.md");
const NAME = "(?:S3RCH_|PANOPTICON_|GUN_)[A-Z0-9_]+";

function collectMatches(text, pattern) {
  const found = new Set();
  for (const match of text.matchAll(pattern)) found.add(match[1]);
  return found;
}

export function readsInSource(text, broad) {
  const found = new Set();
  for (const name of collectMatches(text, new RegExp(`["'](${NAME})["']`, "g"))) found.add(name);
  for (const name of collectMatches(text, new RegExp(`(?:process\\.env|\\benv)\\.(${NAME})`, "g"))) {
    found.add(name);
  }
  if (broad) {
    for (const name of collectMatches(text, new RegExp(`\\b(${NAME})\\b`, "g"))) found.add(name);
  }
  return found;
}

function classify(rel) {
  if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx") || rel.endsWith(".test.js")) return null;
  if (rel === "scripts/check-config-reference.mjs") return null;
  if (rel.endsWith(".md")) return null;
  if (rel.endsWith(".sh") || rel.endsWith(".py")) return "broad";
  if (rel.startsWith(".github/workflows/") && (rel.endsWith(".yml") || rel.endsWith(".yaml"))) return "broad";
  if (/\.(cjs|mjs|js|ts|tsx)$/.test(rel)) return "strict";
  return null;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git" || entry.name === "data") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "docs") continue;
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

export function collectReads(root = ROOT) {
  const found = new Map();
  for (const full of walk(root)) {
    const rel = path.relative(root, full).split(path.sep).join("/");
    const mode = classify(rel);
    if (!mode) continue;
    const text = fs.readFileSync(full, "utf8");
    for (const name of readsInSource(text, mode === "broad")) {
      if (!found.has(name)) found.set(name, []);
      found.get(name).push(rel);
    }
  }
  return found;
}

function documentedNames(text) {
  const names = new Set();
  for (const line of text.split("\n")) {
    const match = line.match(/^\|\s*`((?:S3RCH_|PANOPTICON_|GUN_)[A-Z0-9_]+)`\s*\|/);
    if (match) names.add(match[1]);
  }
  return names;
}

function selfTest() {
  const strict = readsInSource(
    [
      'export const S3RCH_ROOT = "s3rch";',
      "const file = process.env.GUN_FILE;",
      "const forum = env.S3RCH_FORUM;",
      'export const ENV_API_KEY = "PANOPTICON_API_KEY";',
      "export const PANOPTICON_ALLOCATE_PATH = \"/api/v1/turn/allocate\";",
    ].join("\n"),
    false,
  );
  const expectStrict = ["GUN_FILE", "S3RCH_FORUM", "PANOPTICON_API_KEY"];
  for (const name of expectStrict) {
    if (!strict.has(name)) throw new Error(`self-test missed ${name}`);
  }
  if (strict.has("S3RCH_ROOT") || strict.has("PANOPTICON_ALLOCATE_PATH")) {
    throw new Error(`self-test treated a constant as a setting: ${[...strict].join(",")}`);
  }
  const broad = readsInSource('echo "$S3RCH_PANOPTICON_TENANT_ID"', true);
  if (!broad.has("S3RCH_PANOPTICON_TENANT_ID")) throw new Error("self-test missed shell name");
}

function main() {
  selfTest();
  const reads = collectReads();
  if (process.argv.includes("--list")) {
    for (const name of [...reads.keys()].sort()) {
      console.log(`${name}\t${reads.get(name).join(",")}`);
    }
    return;
  }
  if (!fs.existsSync(DOC)) {
    console.error("Missing docs/configuration.md");
    process.exit(1);
  }
  const documented = documentedNames(fs.readFileSync(DOC, "utf8"));
  const missing = [...reads.keys()].filter((name) => !documented.has(name)).sort();
  const extra = [...documented].filter((name) => !reads.has(name)).sort();
  if (missing.length || extra.length) {
    if (missing.length) {
      console.error("Code reads settings missing from docs/configuration.md:");
      for (const name of missing) console.error(`  ${name} (${reads.get(name).join(", ")})`);
    }
    if (extra.length) {
      console.error("docs/configuration.md lists settings the scanned code does not read:");
      for (const name of extra) console.error(`  ${name}`);
    }
    process.exit(1);
  }
  console.log(`configuration reference matches ${documented.size} settings`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
