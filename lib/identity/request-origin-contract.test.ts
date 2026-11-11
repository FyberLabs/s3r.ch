import assert from "node:assert/strict";
import test from "node:test";
import { POST as verify } from "../../app/api/identity/verify/route";
import { identitySecretOrThrow } from "./http";
import { issueNonce } from "./nonce";
import { buildSiweMessage } from "./siwe";

// Invoke the route directly: no server, live RPC, identity store or session.
// Local chain 31337 disables ERC-1271 network fallback for the invalid signature.
for (const domain of ["s3r.ch", "test.s3r.ch", "localhost:3000"]) {
  test(`SIWE route binds normalized forwarded host for ${domain}`, async () => {
    const { nonce, token } = await issueNonce(identitySecretOrThrow());
    const message = buildSiweMessage({ domain, uri: `https://${domain}`,
      address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", chainId: 31337, nonce,
      expirationTime: new Date(Date.now() + 60000) });
    for (const [host, expected, error] of [
      [domain, 401, "SIWE signature is invalid."],
      ["attacker.invalid", 400, "SIWE domain does not match this host."],
    ] as const) {
      const response = await verify(new Request("http://internal:8080/api/identity/verify", {
        method: "POST", headers: { "content-type": "application/json", host: domain,
          "x-forwarded-host": host, "x-forwarded-proto": "https",
          cookie: `__Host-s3rch-nonce=${token}` },
        body: JSON.stringify({ message, signature: `0x${"00".repeat(65)}` }),
      }));
      assert.equal(response.status, expected);
      assert.deepEqual(await response.json(), { error });
      assert.deepEqual(response.headers.getSetCookie(), []);
    }
  });
}

test("direct localhost SIWE reaches signature verification without forwarding headers", async () => {
  const { nonce, token } = await issueNonce(identitySecretOrThrow());
  const message = buildSiweMessage({ domain: "localhost:3000", uri: "http://localhost:3000",
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", chainId: 31337, nonce,
    expirationTime: new Date(Date.now() + 60000) });
  const response = await verify(new Request("http://localhost:3000/api/identity/verify", {
    method: "POST", headers: { "content-type": "application/json", cookie: `Host-s3rch-nonce=${token}` },
    body: JSON.stringify({ message, signature: `0x${"00".repeat(65)}` }),
  }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "SIWE signature is invalid." });
  assert.deepEqual(response.headers.getSetCookie(), []);
});
