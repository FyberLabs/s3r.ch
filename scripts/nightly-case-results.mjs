import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Write only allowlisted case names and fixed outcomes. Never serialize reasons,
 * browser errors, URLs, credentials or arbitrary assertion messages.
 * @param {{suite: string, expectedCases: readonly string[], cases: unknown, evidenceDir?: string}} input
 */
export function writeNightlyCaseResults({ suite, expectedCases, cases, evidenceDir = process.env.TEST_EVIDENCE_DIR }) {
  const safeName = value => typeof value === "string" && /^[a-z][a-z0-9-]{0,95}$/.test(value);
  if (!safeName(suite) || !Array.isArray(expectedCases) || !expectedCases.length ||
      expectedCases.some(name => !safeName(name) || name === "case-report-invalid") ||
      new Set(expectedCases).size !== expectedCases.length) throw Error("Invalid nightly case configuration");
  const expected = new Set(expectedCases), seen = new Set(), statuses = new Map();
  let invalid = !Array.isArray(cases);
  if (Array.isArray(cases)) for (const row of cases) {
    if (!row || typeof row !== "object" || !expected.has(row.name) || seen.has(row.name) ||
        !["passed", "failed", "blocked"].includes(row.status)) { invalid = true; continue; }
    seen.add(row.name); statuses.set(row.name, row.status);
  }
  if (seen.size !== expected.size) invalid = true;
  // A malformed report cannot certify any scenario as passed.
  const normalized = expectedCases.map(name => ({ name, status: invalid ? "blocked" : statuses.get(name) }));
  const failed = normalized.filter(row => row.status === "failed").length;
  const skipped = normalized.filter(row => row.status === "blocked").length;
  const status = invalid || failed ? "failed" : skipped ? "blocked" : "passed";
  const rows = normalized.map(row => `    <testcase classname="${suite}" name="${row.name}">${
    row.status === "blocked" ? '<skipped message="not-completed"/>' :
      row.status === "failed" ? '<failure message="scenario-failed"/>' : ""}</testcase>`);
  if (invalid) rows.push(`    <testcase classname="${suite}" name="case-report-invalid"><failure message="invalid-case-report"/></testcase>`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="${suite}" tests="${rows.length}" failures="${failed + Number(invalid)}" errors="0" skipped="${skipped}">\n${rows.join("\n")}\n  </testsuite>\n</testsuites>\n`;
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    const destination = join(evidenceDir, `${suite}.xml`), temporary = destination + `.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, xml, { encoding: "utf8", mode: 0o600 }); renameSync(temporary, destination); }
    finally { rmSync(temporary, { force: true }); }
  }
  return { status, cases: normalized };
}
