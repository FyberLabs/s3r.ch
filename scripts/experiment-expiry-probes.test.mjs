import test from "node:test";
import assert from "node:assert/strict";
import { checkExperimentExpiry } from "./experiment-expiry-probes.mjs";
const assignment = { variant: "create", cohort: "a".repeat(64), expiresAt: 1060 };
function fixture(overrides = {}) {
  let time = 1000000;
  const operations = [], cases = [];
  return { operations, cases, input: {
    assignment, latest: () => assignment, now: () => time,
    offline: async value => operations.push(["offline", value]),
    wait: async milliseconds => { assert.ok(milliseconds >= 0); time += milliseconds; },
    label: async variant => operations.push(["label", variant, time]),
    recover: async () => ({ ...assignment, expiresAt: Math.floor(time / 1000) + 60 }),
    passed: name => cases.push(name), ...overrides,
  } };
}
test("waits through the actual deadline and recovers without resetting assignment", async () => {
  const f = fixture(); await checkExperimentExpiry(f.input);
  assert.deepEqual(f.operations, [["offline", true], ["label", "create", 1005500], ["label", "create", 1058000], ["label", "control", 1061000], ["offline", false], ["label", "create", 1061000]]);
  assert.deepEqual(f.cases, ["browser-display-expires-offline", "browser-display-recovers-online"]);
});
test("always restores networking after an expiry assertion fails", async () => {
  const f = fixture({ label: async () => { throw Error("wrong visible label"); } });
  await assert.rejects(checkExperimentExpiry(f.input));
  assert.deepEqual(f.operations, [["offline", true], ["offline", false]]);
  assert.deepEqual(f.cases, []);
});
for (const invalid of [{ ...assignment, variant: "control" }, { ...assignment, expiresAt: 1000 }, { ...assignment, expiresAt: 999999 }, { ...assignment, expiresAt: null }]) {
  test(`refuses unusable starting treatment ${JSON.stringify(invalid)}`, async () => {
    const f = fixture({ latest: () => invalid });
    await assert.rejects(checkExperimentExpiry(f.input));
    assert.deepEqual(f.cases, []);
    assert.deepEqual(f.operations.at(-1), ["offline", false]);
  });
}
test("new cohort after recovery is a failure", async () => {
  const f = fixture({ recover: async () => ({ ...assignment, cohort: "b".repeat(64), expiresAt: 1120 }) });
  await assert.rejects(checkExperimentExpiry(f.input));
  assert.deepEqual(f.cases, ["browser-display-expires-offline"]);
});

test("fractional native-session deadlines remain valid", async () => {
  const f = fixture({ latest: () => ({ ...assignment, expiresAt: 1060.25 }) });
  await checkExperimentExpiry(f.input);
  assert.equal(f.cases.length, 2);
});
