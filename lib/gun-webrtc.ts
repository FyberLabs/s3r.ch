/**
 * Browser Gun WebRTC path for gun 0.2020.1241.
 *
 * The adapter is a side-effect IIFE (`gun/lib/webrtc`) that hooks
 * `Gun.on('opt')` and reads `opt.rtc.iceServers`. It must be imported
 * after `gun/browser` has set `window.Gun` and **before** `Gun(opts)` —
 * `root.once` skips later opt. See `node_modules/gun/lib/webrtc.js`.
 *
 * ICE here is **STUN only**. Google public `stun.l.google.com:19302` is
 * STUN, not TURN. Do not document Google as free TURN. Do not stand up
 * TURN on App Service. Requirements (lab infra vs Panopticon): 
 * `docs/durable-graph-and-turn.md`. Do not put TURN secrets on Gun.
 *
 * WebRTC is additive to `listenThenConnectSeedPeer`. If ICE fails, the
 * feed falls open to the same-origin `/gun` seed peer / snapshot.
 * Do not call `user.recall({ sessionStorage: true })`.
 */

export const GUN_WEBRTC_IMPORT = "gun/lib/webrtc";

/** Public Google STUN. Not TURN. NAT'd peers may still need the seed peer. */
export const GOOGLE_STUN_URL = "stun:stun.l.google.com:19302";

export const WEBRTC_ATTEMPTED_HINT = "WebRTC attempted (STUN ≠ TURN)";

export type StunIceServer = {
  urls: string;
};

export type StunOnlyRtcOptions = {
  iceServers: StunIceServer[];
};

export type BrowserRtcEnv = {
  RTCPeerConnection?: unknown;
  webkitRTCPeerConnection?: unknown;
  mozRTCPeerConnection?: unknown;
  RTCSessionDescription?: unknown;
  webkitRTCSessionDescription?: unknown;
  mozRTCSessionDescription?: unknown;
  RTCIceCandidate?: unknown;
  webkitRTCIceCandidate?: unknown;
  mozRTCIceCandidate?: unknown;
  Gun?: unknown;
};

export function stunOnlyIceServers(): StunIceServer[] {
  return [{ urls: GOOGLE_STUN_URL }];
}

/**
 * `opt.rtc` payload Gun's webrtc adapter merges on first opt.
 * STUN-only iceServers. No `turn:` / `turns:` URLs.
 */
export function stunOnlyRtcOptions(): StunOnlyRtcOptions {
  return {
    iceServers: stunOnlyIceServers(),
  };
}

export function iceServerUrls(server: {
  urls?: string | string[];
  url?: string;
}): string[] {
  if (Array.isArray(server.urls)) return server.urls;
  if (typeof server.urls === "string") return [server.urls];
  if (typeof server.url === "string") return [server.url];
  return [];
}

/** True only when every listed URL is `stun:` (not `turn:` / `turns:`). */
export function isStunOnlyIceServer(server: {
  urls?: string | string[];
  url?: string;
}): boolean {
  const urls = iceServerUrls(server);
  if (urls.length === 0) return false;
  return urls.every(
    (url) =>
      url.startsWith("stun:") &&
      !url.startsWith("turn:") &&
      !url.startsWith("turns:"),
  );
}

/**
 * Same constructors `gun/lib/webrtc` requires. Does not construct
 * RTCPeerConnection — Node CI has none, and a live PC is flaky.
 */
export function canUseBrowserRtc(env: BrowserRtcEnv): boolean {
  const rtcpc =
    env.RTCPeerConnection ??
    env.webkitRTCPeerConnection ??
    env.mozRTCPeerConnection;
  const rtcsd =
    env.RTCSessionDescription ??
    env.webkitRTCSessionDescription ??
    env.mozRTCSessionDescription;
  const rtcic =
    env.RTCIceCandidate ??
    env.webkitRTCIceCandidate ??
    env.mozRTCIceCandidate;
  return (
    typeof rtcpc === "function" &&
    typeof rtcsd === "function" &&
    typeof rtcic === "function"
  );
}

export function webrtcHintLine(attempted: boolean): string | null {
  return attempted ? WEBRTC_ATTEMPTED_HINT : null;
}

export function withWebrtcHint(status: string, attempted: boolean): string {
  const hint = webrtcHintLine(attempted);
  return hint ? `${status} · ${hint}` : status;
}

/**
 * Bind the `gun/browser` constructor onto `window.Gun` so the IIFE does
 * not `require('../gun')` (Node build) in a Next client bundle.
 */
export function bindWindowGun(env: BrowserRtcEnv, gunCtor: unknown): boolean {
  if (typeof gunCtor !== "function") return false;
  env.Gun = gunCtor;
  return true;
}

export type ImportWebrtc = () => Promise<unknown>;

/**
 * Load `gun/lib/webrtc` when RTC constructors exist. No-ops in Node /
 * SSR. Never instantiates RTCPeerConnection. Caller must bind Gun first
 * and construct Gun **after** this returns.
 */
export async function attachGunWebrtcLib(
  gunCtor: unknown,
  env: BrowserRtcEnv = globalThis as BrowserRtcEnv,
  load: ImportWebrtc = () => import("gun/lib/webrtc"),
): Promise<boolean> {
  if (!canUseBrowserRtc(env)) return false;
  if (!bindWindowGun(env, gunCtor)) return false;
  try {
    await load();
    return true;
  } catch {
    return false;
  }
}
