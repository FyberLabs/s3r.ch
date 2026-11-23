import assert from "node:assert/strict";
import { test } from "node:test";
import { testOriginAllowed } from "./test-origin-guard";

const expected = "01234567-89ab-5def-8123-456789abcdef";

test("existing origins keep platform ingress policy and opted-in origins require the exact header", () => {
  assert.equal(testOriginAllowed(undefined, undefined), true);
  assert.equal(testOriginAllowed(expected, expected), true);
  for (const header of [undefined, "", expected.toUpperCase(), [expected], expected + "," + expected]) {
    assert.equal(testOriginAllowed(expected, header), false);
  }
  assert.equal(testOriginAllowed("", undefined), false);
});

test("only the read-only HTTP health probe can omit the configured origin header", () => {
  assert.equal(testOriginAllowed(expected, undefined, { method: "GET", pathname: "/api/health" }), true);
  assert.equal(testOriginAllowed(expected, undefined, { method: "POST", pathname: "/api/health" }), false);
  assert.equal(testOriginAllowed(expected, undefined, { method: "GET", pathname: "/api/version" }), false);
  assert.equal(testOriginAllowed("misconfigured", undefined, { method: "GET", pathname: "/api/health" }), false);
  assert.equal(testOriginAllowed(expected, undefined), false);
});
