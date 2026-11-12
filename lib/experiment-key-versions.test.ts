import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { experimentKeyVersion, readExperimentKeyVersions, signExperimentKeyVersions } from "./experiment-key-versions";
const secret = new Uint8Array(32).fill(97);
const anonymous = "12345678-1234-4234-8234-123456789abc";
const row = { key: "layout", hash: "a".repeat(64), version: experimentKeyVersion(secret) };
const type = "s3rch-experiment-key-versions-v1";
async function signed(versions: unknown, iat = 100, exp = 31536100) {
  return new SignJWT({ anonymous, versions }).setProtectedHeader({ alg: "HS256", typ: type })
    .setIssuer("s3rch").setAudience(type).setIssuedAt(iat).setExpirationTime(exp).sign(secret);
}

test("signed metadata rejects malformed rows, duplicates, timestamps and oversized input", async () => {
  for (const versions of [null, {}, [null], [{}], [row, row], Array(9).fill(row),
    ...["key", "hash", "version"].flatMap(field => [[{ ...row, [field]: 7 }], [{ ...row, [field]: "bad!" }]]),
    [{ ...row, extra: "private" }]]) {
    assert.deepEqual(await readExperimentKeyVersions(await signed(versions), anonymous, [secret], 101), []);
  }
  for (const [iat, exp] of [[102, 31536102], [100, 31536101], [100.5, 31536100.5], [0, 1]]) {
    assert.deepEqual(await readExperimentKeyVersions(await signed([row], iat, exp), anonymous, [secret], 101), []);
  }
  for (const token of [null, "x".repeat(3801), "malformed"]) {
    assert.deepEqual(await readExperimentKeyVersions(token, anonymous, [secret], 101), []);
  }
});

test("metadata cookie preserves exact pairs and enforces its output budget", async () => {
  const cookie = await signExperimentKeyVersions([row], anonymous, secret, 100);
  assert.match(cookie, /; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000$/);
  const token = cookie.split(";")[0].split("=")[1];
  assert.deepEqual(await readExperimentKeyVersions(token, anonymous, [secret], 101), [row]);
  assert.deepEqual(await readExperimentKeyVersions(token, "other", [secret], 101), []);
  assert.deepEqual(await readExperimentKeyVersions(token, anonymous, [new Uint8Array(32).fill(98)], 101), []);
  await assert.rejects(() => signExperimentKeyVersions(Array(30).fill(row), anonymous, secret, 100), /cookie limit/);
});
