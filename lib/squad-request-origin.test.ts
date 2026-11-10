import assert from "node:assert/strict";
import test from "node:test";
import { matchesSquadOrigin } from "./squad-request-origin";

test("TLS termination requires the canonical Host and browser Origin", () => {
  const origin = new URL("https://test.s3r.ch");
  const headers = { host: origin.host, origin: origin.origin, "x-forwarded-proto": "https" };
  const matches = (values: Record<string, string>) =>
    matchesSquadOrigin(new Request("http://localhost:3000/api/squad", { headers: values }), origin);
  assert.ok(matches(headers));
  assert.ok(!matches({ ...headers, host: "other.example", "x-forwarded-host": origin.host }));
  assert.ok(!matches({ ...headers, origin: "https://other.example" }));
  assert.ok(!matches({ ...headers, "x-forwarded-proto": "http" }));
  assert.ok(!matches({ origin: origin.origin, "x-forwarded-host": origin.host, "x-forwarded-proto": "https" }));
});
