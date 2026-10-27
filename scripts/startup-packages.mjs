/**
 * Packages require()'d from the preload and identity workers, outside the
 * Next.js server bundle. Prints one package name per line.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function packageName(spec) {
  if (spec.startsWith("@")) {
    const [scope, name] = spec.split("/");
    if (!scope || !name) throw new Error(`bad package spec ${spec}`);
    return `${scope}/${name}`;
  }
  return spec.split("/")[0];
}

function walk(file, seen, packages) {
  const abs = path.resolve(file);
  if (seen.has(abs) || !fs.existsSync(abs)) return;
  seen.add(abs);
  const text = fs.readFileSync(abs, "utf8");
  for (const match of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
    const spec = match[1];
    if (spec.startsWith("node:")) continue;
    if (spec.startsWith(".")) {
      let next = path.resolve(path.dirname(abs), spec);
      if (!fs.existsSync(next) && fs.existsSync(`${next}.cjs`)) next = `${next}.cjs`;
      walk(next, seen, packages);
      continue;
    }
    packages.add(packageName(spec));
  }
}

function seeds() {
  const files = [path.join(ROOT, "gun-preload.cjs")];
  for (const name of fs.readdirSync(ROOT)) {
    if (name.startsWith("identity-") && name.endsWith(".cjs")) files.push(path.join(ROOT, name));
  }
  return files;
}

export function startupPackages() {
  const packages = new Set();
  const seen = new Set();
  for (const file of seeds()) walk(file, seen, packages);
  return [...packages].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packages = startupPackages();
  if (!packages.includes("viem")) {
    console.error("startup package list does not include viem");
    process.exit(1);
  }
  for (const name of packages) console.log(name);
}
