import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LOCAL_SESSION_SECRET } from "./config";
import {
  cookieOptions,
  nonceCookieName,
  nonceCookieNames,
  readCookie,
  requestHost,
  requestIsSecure,
  serializeCookie,
  sessionCookieName,
} from "./cookies";
import { issueNonce, readNonceToken, signNonceToken } from "./nonce";
import { getIdentitySecret, IdentitySecretError } from "./secret";

const SECRET = LOCAL_SESSION_SECRET;

describe("nonce cookie", () => {
  it("roundtrips a signed nonce", async () => {
    const { nonce, token } = await issueNonce(SECRET);
    assert.match(nonce, /^[a-zA-Z0-9]{8,}$/);
    const claims = await readNonceToken(token, SECRET);
    assert.equal(claims.nonce, nonce);
    assert.ok(claims.exp > claims.iat);
  });

  it("rejects a tampered nonce token", async () => {
    const token = await signNonceToken("abc12345", SECRET);
    await assert.rejects(() => readNonceToken(`${token}x`, SECRET));
  });

  it("serializes Host- vs __Host- by scheme", () => {
    assert.equal(nonceCookieName(true), "__Host-s3rch-nonce");
    assert.equal(nonceCookieName(false), "Host-s3rch-nonce");
    assert.equal(sessionCookieName(true), "__Host-s3rch-session");
    assert.deepEqual(nonceCookieNames(), ["__Host-s3rch-nonce", "Host-s3rch-nonce"]);

    const header = serializeCookie(
      nonceCookieName(false),
      "tok",
      cookieOptions(false, 300),
    );
    assert.match(header, /^Host-s3rch-nonce=tok;/);
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    assert.doesNotMatch(header, /Secure/);
    assert.equal(readCookie(header, nonceCookieNames()), "tok");

    const hostHeader = serializeCookie(
      nonceCookieName(true),
      "sec",
      cookieOptions(true, 300),
    );
    assert.match(hostHeader, /Secure/);
    assert.doesNotMatch(hostHeader, /Domain=/);
  });

  it("reads host and https from forwarded headers", () => {
    const request = new Request("http://internal/", {
      headers: {
        host: "localhost:3000",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "s3r.ch",
      },
    });
    assert.equal(requestIsSecure(request), true);
    assert.equal(requestHost(request), "s3r.ch");
  });
});

describe("IDENTITY_SESSION_SECRET", () => {
  it("falls back locally when unset", () => {
    assert.equal(getIdentitySecret({ NODE_ENV: "development" }), LOCAL_SESSION_SECRET);
  });

  it("throws in production when missing", () => {
    assert.throws(
      () => getIdentitySecret({ NODE_ENV: "production" }),
      IdentitySecretError,
    );
  });

  it("rejects a short secret", () => {
    assert.throws(
      () => getIdentitySecret({ IDENTITY_SESSION_SECRET: "too-short", NODE_ENV: "development" }),
      IdentitySecretError,
    );
  });

  it("accepts a long secret", () => {
    const secret = "x".repeat(32);
    assert.equal(getIdentitySecret({ IDENTITY_SESSION_SECRET: secret }), secret);
  });
});
