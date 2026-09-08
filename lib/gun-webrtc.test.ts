import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  attachGunWebrtcLib,
  bindWindowGun,
  canUseBrowserRtc,
  GOOGLE_STUN_URL,
  GUN_WEBRTC_IMPORT,
  iceServerUrls,
  isStunOnlyIceServer,
  stunOnlyIceServers,
  stunOnlyRtcOptions,
  WEBRTC_ATTEMPTED_HINT,
  webrtcHintLine,
  withWebrtcHint,
  type BrowserRtcEnv,
} from "./gun-webrtc";

function helperSource(): string {
  return readFileSync(new URL("./gun-webrtc.ts", import.meta.url), "utf8");
}

function fakeRtcEnv(overrides: BrowserRtcEnv = {}): BrowserRtcEnv {
  return {
    RTCPeerConnection: function RTCPeerConnection() {},
    RTCSessionDescription: function RTCSessionDescription() {},
    RTCIceCandidate: function RTCIceCandidate() {},
    ...overrides,
  };
}

describe("STUN-only ICE", () => {
  it("lists Google public STUN and no TURN urls", () => {
    const servers = stunOnlyIceServers();
    assert.deepEqual(servers, [{ urls: GOOGLE_STUN_URL }]);
    assert.equal(GOOGLE_STUN_URL, "stun:stun.l.google.com:19302");
    assert.equal(isStunOnlyIceServer(servers[0]), true);
    assert.deepEqual(iceServerUrls(servers[0]), [GOOGLE_STUN_URL]);
    for (const server of stunOnlyRtcOptions().iceServers) {
      assert.equal(isStunOnlyIceServer(server), true);
    }
  });

  it("rejects TURN, mixed, and empty ICE servers", () => {
    assert.equal(isStunOnlyIceServer({ urls: "turn:example.test:3478" }), false);
    assert.equal(isStunOnlyIceServer({ urls: "turns:example.test:5349" }), false);
    assert.equal(
      isStunOnlyIceServer({
        urls: [GOOGLE_STUN_URL, "turn:example.test:3478"],
      }),
      false,
    );
    assert.equal(isStunOnlyIceServer({}), false);
    assert.equal(isStunOnlyIceServer({ url: "stun:stun.example.test" }), true);
  });

  it("does not document Google as free TURN", () => {
    const src = helperSource();
    assert.equal(src.includes(GUN_WEBRTC_IMPORT), true);
    assert.equal(/urls:\s*['"]turns?:/.test(src), false);
    assert.equal(src.includes("turn:stun.l.google.com"), false);
    assert.equal(src.includes("Do not document Google as free TURN"), true);
    assert.equal(src.includes("STUN, not TURN"), true);
    assert.equal(src.includes("user.recall({ sessionStorage: true })"), true);
  });
});

describe("browser RTC guard", () => {
  it("requires the three constructors gun/lib/webrtc checks", () => {
    assert.equal(canUseBrowserRtc({}), false);
    assert.equal(canUseBrowserRtc(globalThis as BrowserRtcEnv), false);
    assert.equal(
      canUseBrowserRtc({ RTCPeerConnection: function RTCPeerConnection() {} }),
      false,
    );
    assert.equal(canUseBrowserRtc(fakeRtcEnv()), true);
    assert.equal(
      canUseBrowserRtc(
        fakeRtcEnv({
          RTCPeerConnection: undefined,
          webkitRTCPeerConnection: function webkitRTCPeerConnection() {},
        }),
      ),
      true,
    );
  });

  it("binds the gun/browser constructor onto the env", () => {
    const env: BrowserRtcEnv = {};
    function Gun() {}
    assert.equal(bindWindowGun(env, "not-a-ctor"), false);
    assert.equal(bindWindowGun(env, Gun), true);
    assert.equal(env.Gun, Gun);
  });

  it("does not import webrtc when RTC is missing (Node CI)", async () => {
    let loaded = 0;
    const ok = await attachGunWebrtcLib(
      function Gun() {},
      {},
      async () => {
        loaded += 1;
      },
    );
    assert.equal(ok, false);
    assert.equal(loaded, 0);
  });

  it("loads the webrtc module after binding Gun when RTC exists", async () => {
    let loaded = 0;
    const env = fakeRtcEnv();
    function Gun() {}
    const ok = await attachGunWebrtcLib(Gun, env, async () => {
      loaded += 1;
      assert.equal(env.Gun, Gun);
    });
    assert.equal(ok, true);
    assert.equal(loaded, 1);
  });

  it("falls open when the webrtc import throws", async () => {
    const ok = await attachGunWebrtcLib(
      function Gun() {},
      fakeRtcEnv(),
      async () => {
        throw new Error("no webrtc in this bundle");
      },
    );
    assert.equal(ok, false);
  });

  it("does not load webrtc when Gun was not a constructor", async () => {
    let loaded = 0;
    const ok = await attachGunWebrtcLib(
      undefined,
      fakeRtcEnv(),
      async () => {
        loaded += 1;
      },
    );
    assert.equal(ok, false);
    assert.equal(loaded, 0);
  });
});

describe("WebRTC status hint", () => {
  it("is a quiet attempted line, not a live mesh claim", () => {
    assert.equal(WEBRTC_ATTEMPTED_HINT, "WebRTC attempted (STUN ≠ TURN)");
    assert.equal(webrtcHintLine(false), null);
    assert.equal(webrtcHintLine(true), WEBRTC_ATTEMPTED_HINT);
    assert.equal(withWebrtcHint("seed peer (ws)", false), "seed peer (ws)");
    assert.equal(
      withWebrtcHint("seed peer (ws)", true),
      "seed peer (ws) · WebRTC attempted (STUN ≠ TURN)",
    );
    assert.equal(WEBRTC_ATTEMPTED_HINT.toLowerCase().includes("mesh"), false);
    assert.equal(WEBRTC_ATTEMPTED_HINT.toLowerCase().includes("p2p"), false);
    assert.equal(WEBRTC_ATTEMPTED_HINT.toLowerCase().includes("live"), false);
  });
});
