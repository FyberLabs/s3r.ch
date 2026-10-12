import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HOP_ENV } from "./turn-allocate.fixtures";
import { readStaticTurnServer, sessionGatedAllocate } from "./turn-allocate";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const STATIC_ENV = {
  S3RCH_TURN_URLS: "turn:relay.example.org:3478, turns:relay.example.org:5349",
  S3RCH_TURN_USERNAME: "s3rch",
  S3RCH_TURN_CREDENTIAL: "relay-secret",
};
const NOW = Date.parse("2026-10-12T12:00:00.000Z");

describe("static TURN fallback", () => {
  it("reads a public relay with credentials", () => {
    assert.deepEqual(readStaticTurnServer(STATIC_ENV), {
      urls: ["turn:relay.example.org:3478", "turns:relay.example.org:5349"],
      username: "s3rch",
      credential: "relay-secret",
    });
  });

  it("rejects a turn URL without credentials and private relay hosts", () => {
    assert.equal(readStaticTurnServer({ S3RCH_TURN_URLS: "turn:relay.example.org:3478" }), null);
    assert.equal(readStaticTurnServer({ ...STATIC_ENV, S3RCH_TURN_URLS: "turn:10.0.0.4:3478" }), null);
    assert.equal(readStaticTurnServer({}), null);
    assert.equal(readStaticTurnServer({ ...STATIC_ENV, S3RCH_TURN_URLS: "turn:relay.example.org:70000" }), null);
    assert.equal(readStaticTurnServer({ ...STATIC_ENV, S3RCH_TURN_URLS: "turn:relay.example.org:0" }), null);
  });

  it("treats upper-case TURN schemes as TURN and still requires credentials", () => {
    assert.equal(readStaticTurnServer({ S3RCH_TURN_URLS: "TURN:relay.example.org:3478" }), null);
    assert.deepEqual(readStaticTurnServer({ ...STATIC_ENV, S3RCH_TURN_URLS: "TURNS:relay.example.org:5349" }), {
      urls: "turns:relay.example.org:5349",
      username: "s3rch",
      credential: "relay-secret",
    });
  });

  it("accepts public IPv6 relays and rejects private IPv6 ones", () => {
    assert.ok(readStaticTurnServer({ ...STATIC_ENV, S3RCH_TURN_URLS: "turn:[2606:4700::1]:3478" }));
    assert.ok(readStaticTurnServer({ ...STATIC_ENV, S3RCH_TURN_URLS: "turn:[::ffff:8.8.8.8]:3478" }));
    for (const host of ["[::1]", "[0:0:0:0:0:0:0:1]", "[::]", "[fd00::1]", "[fe80::1]", "[::ffff:10.0.0.1]", "[0:0:0:0:0:ffff:a00:1]"]) {
      assert.equal(readStaticTurnServer({ ...STATIC_ENV, S3RCH_TURN_URLS: `turn:${host}:3478` }), null, host);
    }
  });

  it("allows a STUN-only static list", () => {
    assert.deepEqual(readStaticTurnServer({ S3RCH_TURN_URLS: "stun:stun.example.org:3478" }), {
      urls: "stun:stun.example.org:3478",
    });
  });

  it("serves the static relay when the allocate service is not configured", async () => {
    const result = await sessionGatedAllocate({ sessionAddress: ADDRESS, env: STATIC_ENV, now: NOW });
    assert.equal(result.status, 200);
    assert.equal(result.body && "expiresAt" in result.body && result.body.expiresAt, "2026-10-12T12:05:00.000Z");
  });

  it("serves the static relay when the allocate service fails", async () => {
    let calls = 0;
    const result = await sessionGatedAllocate({
      sessionAddress: ADDRESS,
      env: { ...HOP_ENV, ...STATIC_ENV },
      now: NOW,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("offline");
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 200);
  });

  it("stays STUN-only (503) with nothing configured", async () => {
    const result = await sessionGatedAllocate({ sessionAddress: ADDRESS, env: {} });
    assert.deepEqual(result, { status: 503, body: { error: "turn-unconfigured" } });
  });

  it("still requires a session", async () => {
    const result = await sessionGatedAllocate({ sessionAddress: null, env: STATIC_ENV });
    assert.equal(result.status, 401);
  });
});
