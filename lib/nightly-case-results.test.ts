import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeNightlyCaseResults } from "../scripts/nightly-case-results.mjs";
const names = ["grant", "view", "revoke"];
function fixture(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "nightly-case-unit-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("nightly evidence records each fixed outcome and strips private diagnostic fields", () => fixture(dir => {
  const cases = names.map((name, index) => ({ name, status: ["passed", "failed", "blocked"][index], reason: "private-token<&", url: "https://private.invalid" }));
  const result = writeNightlyCaseResults({ suite: "sea-grants", expectedCases: names, cases, evidenceDir: dir });
  assert.equal(result.status, "failed");
  const xml = readFileSync(join(dir, "sea-grants.xml"), "utf8");
  assert.match(xml, /tests="3" failures="1" errors="0" skipped="1"/);
  assert.match(xml, /name="grant"><\/testcase>/);
  assert.match(xml, /name="view"><failure message="scenario-failed"\/>/);
  assert.match(xml, /name="revoke"><skipped message="not-completed"\/>/);
  assert.doesNotMatch(xml + JSON.stringify(result), /private|reason|url/);
  assert.deepEqual(readdirSync(dir), ["sea-grants.xml"]);
}));
test("missing, duplicate, unknown and invalid outcomes cannot leave a passing report", () => fixture(dir => {
  const good = names.map(name => ({ name, status: "passed" }));
  for (const cases of [null, good.slice(1), [...good, good[0]], [...good, { name: "private-token", status: "passed" }],
    [{ ...good[0], status: "private-token" }, ...good.slice(1)]]) {
    const result = writeNightlyCaseResults({ suite: "sea-grants", expectedCases: names, cases, evidenceDir: dir });
    assert.equal(result.status, "failed"); assert.ok(result.cases.every(row => row.status === "blocked"));
    const xml = readFileSync(join(dir, "sea-grants.xml"), "utf8");
    assert.match(xml, /tests="4" failures="1" errors="0" skipped="3"/);
    assert.match(xml, /name="case-report-invalid"/); assert.doesNotMatch(xml, /private-token/);
  }
}));
test("all passed and all blocked reports retain distinct outcomes; configured names cannot inject XML or paths", () => fixture(dir => {
  for (const status of ["passed", "blocked"] as const) {
    const result = writeNightlyCaseResults({ suite: "sea-grants", expectedCases: names, cases: names.map(name => ({ name, status })), evidenceDir: dir });
    assert.equal(result.status, status);
  }
  for (const suite of ["../escape", 'bad"name', ""]) assert.throws(() => writeNightlyCaseResults({ suite, expectedCases: names, cases: [], evidenceDir: dir }));
  for (const expectedCases of [[], ["grant", "grant"], ['bad"name'], ["case-report-invalid"]])
    assert.throws(() => writeNightlyCaseResults({ suite: "sea-grants", expectedCases, cases: [], evidenceDir: dir }));
}));
