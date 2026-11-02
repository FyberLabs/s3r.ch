import assert from "node:assert/strict";
import test from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { verifyForumWitness, type ForumWitnessKey } from "./forum-witness-verification";

// Public deterministic test key, never a production trust anchor.
const secret = new Uint8Array(32); secret[31] = 7;
const pub = p256.getPublicKey(secret, false);
const b64 = (x: Uint8Array | string) => Buffer.from(x).toString("base64url");
const key: ForumWitnessKey = { kid: "fixture", kty: "EC", crv: "P-256", x: b64(pub.slice(1, 33)), y: b64(pub.slice(33)), notBefore: 100, notAfter: 200 };
const header = '{"alg":"ES256","kid":"fixture","typ":"JWT"}';
function sign(payload = '{"iat":150,"exp":250}', h = header): string {
  const message = b64(h) + "." + b64(payload);
  return message + "." + b64(p256.sign(new TextEncoder().encode(message), secret, { prehash: true, format: "compact" }));
}

test("witness time checks distinguish historical validity from present freshness", () => {
  const token = sign();
  assert.deepEqual(verifyForumWitness(token, [key], 150), { iat: 150, exp: 250 });
  assert.equal(verifyForumWitness(token, [key], 149), null);
  assert.ok(verifyForumWitness(token, [key], 149, 1));
  assert.equal(verifyForumWitness(token, [key], 250), null);
  assert.ok(verifyForumWitness(token, [key], 250, 1));
  assert.equal(verifyForumWitness(token, [key], 251, 1), null);
  for (const iat of [99, 200]) assert.equal(verifyForumWitness(sign(JSON.stringify({ iat, exp: iat + 50 })), [key], iat, 300), null);
  for (const iat of [100, 199]) assert.ok(verifyForumWitness(sign(JSON.stringify({ iat, exp: iat + 50 })), [key], iat));
});

test("requires exactly one explicitly trusted suitable witness key", () => {
  const token = sign();
  for (const keys of [[], [key, key], [{ ...key, kid: "other" }], [{ ...key, notBefore: undefined }],
    [{ ...key, notAfter: 100 }], [{ ...key, x: key.y }], [{ ...key, alg: "ES384" }],
    [{ ...key, use: "enc" }], [{ ...key, key_ops: ["sign"] }], [{ ...key, key_ops: [] }],
    [{ ...key, key_ops: "verify" }], [{ ...key, crv: "P-384" }], [{ ...key, kty: "RSA" }]]) {
    assert.equal(verifyForumWitness(token, keys as unknown as ForumWitnessKey[], 150), null);
  }
  assert.ok(verifyForumWitness(token, [{ ...key, key_ops: ["verify"] }], 150));
  assert.equal(verifyForumWitness(token, Array(1025).fill(key), 150), null);
});

test("rejects ambiguous JSON and unsupported protected headers even when signed", () => {
  for (const h of [
    '{"alg":"none","kid":"fixture"}', '{"alg":"ES256","kid":"fixture","jku":"https://attacker.invalid"}',
    '{"alg":"ES256","kid":"fixture","crit":[]}', '{"alg":"ES256","kid":"fixture","typ":"other"}',
    '{"alg":"ES256","kid":"other","kid":"fixture"}', '{"alg":"ES256","kid":"fixture","k\\u0069d":"fixture"}',
  ]) assert.equal(verifyForumWitness(sign(undefined, h), [key], 150), null);
  for (const payload of [
    '{"iat":149,"iat":150,"exp":250}', '{"iat":150,"exp":250,"nested":{"x":1,"x":2}}',
    '{"iat":150,"exp":250,"x":"\\ud800"}', '{"iat":150,"exp":250,"x":1e999}',
    '{"iat":150,"exp":250} trailing', '{"iat":150,"exp":250,"x":' + '['.repeat(18) + '0' + ']'.repeat(18) + '}',
    'null', '[]', '{"iat":150,"exp":250,}',
  ]) assert.equal(verifyForumWitness(sign(payload), [key], 150), null);
});

test("rejects forged and noncanonical envelopes and invalid time policies", () => {
  const token = sign();
  const parts = token.split('.');
  assert.equal(verifyForumWitness(parts[0] + '.' + b64('{"iat":150,"exp":260}') + '.' + parts[2], [key], 150), null);
  for (const value of [null, {}, token + '.', token + '=', 'x'.repeat(16385), parts[0] + '=.' + parts[1] + '.' + parts[2]]) {
    assert.equal(verifyForumWitness(value, [key], 150), null);
  }
  for (const value of [-0, -1, NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(verifyForumWitness(token, [key], value), null);
    assert.equal(verifyForumWitness(token, [key], 150, value), null);
  }
  assert.equal(verifyForumWitness(token, [key], 150, 301), null);
  for (const payload of ['{"iat":-0,"exp":250}', '{"iat":150,"exp":150}', '{"iat":150,"exp":1051}', '{"iat":150.1,"exp":250}']) {
    assert.equal(verifyForumWitness(sign(payload), [key], 150), null);
  }
  assert.ok(verifyForumWitness(sign('{"iat":150,"exp":1050}'), [key], 150));
});

test("verified claims are deeply frozen and still need record-specific binding", () => {
  const claims = verifyForumWitness(sign('{"iat":150,"exp":250,"typ":"unrelated","nested":{"list":[1]}}'), [key], 150)!;
  assert.ok(Object.isFrozen(claims));
  assert.ok(Object.isFrozen(claims.nested));
  assert.ok(Object.isFrozen((claims.nested as { list: unknown }).list));
  assert.equal(claims.typ, "unrelated");
});

test("verifies copied upstream witness fixtures at their historical issuance time", async () => {
  const { default: vectors } = await import("./vectors/forum-witness.json");
  for (const vector of vectors.accept) {
    assert.deepEqual(verifyForumWitness(vector.token, vectors.keys as ForumWitnessKey[], vector.claims.iat), vector.claims, vector.name);
  }
});
