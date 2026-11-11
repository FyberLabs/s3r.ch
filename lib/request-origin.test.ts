import assert from "node:assert/strict";
import test from "node:test";
import { matchesBrowserOrigin, requestHost, requestIsSecure } from "./request-origin";

test("TLS termination requires the canonical Host and browser Origin", () => {
  const origin = new URL("https://test.s3r.ch");
  const headers = { host: origin.host, origin: origin.origin, "x-forwarded-proto": "https" };
  const matches = (values: Record<string, string>) =>
    matchesBrowserOrigin(new Request("http://localhost:3000/api/squad", { headers: values }), origin);
  assert.ok(matches(headers));
  assert.ok(!matches({ ...headers, "x-forwarded-host": "other.example" }));
  assert.ok(!matches({ ...headers, "x-forwarded-proto": "https,http" }));
  assert.ok(!matches({ ...headers, host: "other.example", "x-forwarded-host": origin.host }));
  assert.ok(!matches({ ...headers, origin: "https://other.example" }));
  assert.ok(!matches({ ...headers, "x-forwarded-proto": "http" }));
  assert.ok(!matches({ origin: origin.origin, "x-forwarded-host": origin.host, "x-forwarded-proto": "https" }));
});


test("normalized forwarding metadata owns public host and cookie scheme", () => {
  const request = new Request("http://internal:8080/api/identity/nonce", {
    headers: { host: "s3r.ch", "x-forwarded-host": "test.s3r.ch", "x-forwarded-proto": "https" },
  });
  assert.equal(requestHost(request), "test.s3r.ch");
  assert.equal(requestIsSecure(request), true);
  // The helper is not the edge authenticator: poisoned metadata must be replaced
  // before it reaches this boundary. Keep that deployment dependency explicit.
  const poisoned = new Request(request, { headers: {
    host: "s3r.ch", "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "http",
  } });
  assert.equal(requestHost(poisoned), "attacker.invalid");
  assert.equal(requestIsSecure(poisoned), false);
});

test("direct localhost development preserves its port and HTTP scheme", () => {
  for (const hostname of ["localhost", "127.0.0.1"]) {
    const origin = new URL(`http://${hostname}:3000`);
    const request = new Request(`${origin}/api/identity/nonce`, { headers: { origin: origin.origin } });
    assert.equal(requestHost(request), origin.host);
    assert.equal(requestIsSecure(request), false);
    assert.equal(matchesBrowserOrigin(request, origin), true);
    assert.equal(matchesBrowserOrigin(request, new URL("https://s3r.ch")), false);
  }
});
