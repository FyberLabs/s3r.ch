#!/usr/bin/env node
/**
 * Read-only scan for the twelve shared forum check-vector SEA pubkeys.
 * Checks local S3RCH_SQUAD_PILOT JSON, optional config file paths, and when
 * S3RCH_STATEMENT_SOURCE_* credentials are present, a read-only statement snapshot.
 *
 * Usage:
 *   node scripts/check-vector-keys-in-acl.mjs [config.json ...]
 *   S3RCH_SQUAD_PILOT='{...}' node scripts/check-vector-keys-in-acl.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { p256 } from "@noble/curves/nist.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vector = JSON.parse(readFileSync(path.join(root, "lib/identity/vectors/forums.json"), "utf8"));

function b64url(bytes) {
  const bin = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join("");
  return Buffer.from(bin, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function seaFromScalar(n) {
  const point = p256.Point.BASE.multiply(BigInt(n)).toBytes(false);
  return `${b64url(point.slice(1, 33))}.${b64url(point.slice(33))}`;
}

const VECTOR_PUBKEYS = Object.freeze([
  vector.seaPubkey,
  vector.secondPubkey,
  ...[3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(seaFromScalar),
]);

const vectorSet = new Set(VECTOR_PUBKEYS);
const hits = [];

function note(source, field, value) {
  hits.push({ source, field, value });
}

function walk(value, source, trail = "") {
  if (typeof value === "string") {
    if (vectorSet.has(value)) note(source, trail || "string", value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, source, `${trail}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const next = trail ? `${trail}.${key}` : key;
    if (typeof child === "string" && vectorSet.has(child)) note(source, next, child);
    else walk(child, source, next);
  }
}

function scanJson(text, source) {
  try {
    walk(JSON.parse(text), source);
  } catch (error) {
    console.error(`skip ${source}: ${error instanceof Error ? error.message : error}`);
  }
}

console.log("Public forum vector pubkeys (12):");
for (const pub of VECTOR_PUBKEYS) console.log(`  ${pub}`);

const pilot = process.env.S3RCH_SQUAD_PILOT;
if (pilot) scanJson(pilot, "env:S3RCH_SQUAD_PILOT");

for (const file of process.argv.slice(2)) {
  scanJson(readFileSync(path.resolve(file), "utf8"), file);
}

const origin = process.env.S3RCH_STATEMENT_SOURCE_ORIGIN;
const tenant = process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID;
const scope = process.env.S3RCH_STATEMENT_SOURCE_SCOPE;
const apiKey = process.env.S3RCH_STATEMENT_SOURCE_API_KEY;
if (origin && tenant && scope && apiKey) {
  const url = new URL("/api/v1/acl/statements/current", origin);
  url.searchParams.set("tenant", tenant);
  url.searchParams.set("scope", scope);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    });
    const body = await response.text();
    if (!response.ok) {
      console.error(`statement source HTTP ${response.status}: ${body.slice(0, 200)}`);
    } else {
      scanJson(body, `GET ${url.origin}${url.pathname}`);
    }
  } catch (error) {
    console.error(`statement source fetch failed: ${error instanceof Error ? error.message : error}`);
  }
} else {
  console.log("\nNo S3RCH_STATEMENT_SOURCE_* credentials in this environment; skipped live ACL fetch.");
}

console.log(`\nScan fingerprint: ${createHash("sha256").update(VECTOR_PUBKEYS.join("\n")).digest("hex")}`);
if (hits.length === 0) {
  console.log("No vector pubkeys found in scanned configuration.");
  process.exit(0);
}
console.log(`Found ${hits.length} reference(s):`);
for (const row of hits) console.log(`  ${row.source} ${row.field}: ${row.value}`);
process.exit(1);