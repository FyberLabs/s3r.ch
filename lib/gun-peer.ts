/**
 * Same-origin Gun seed peer for the browser. Azure App Service is a seed
 * peer + bootstrap cache, not the chat server. WebRTC / ICE / TURN are not
 * this slice. Do not call user.recall({ sessionStorage: true }).
 *
 * Gun's HTTP `web` adapter serves WebSocket at `/gun` (see gun/lib/ws.js
 * `ws.path = ws.path || '/gun'`). The browser mesh replaces `http` with `ws`
 * on the peer URL, so the path must stay `/gun`.
 */

export const GUN_PEER_PATH = "/gun";

export const TRYING_SEED_COPY =
  "Trying seed peer; snapshot if the socket is down";

export const SEED_PEER_WS_STATUS = "seed peer (ws)";
export const SNAPSHOT_ONLY_STATUS = "snapshot only";

export type BrowserGunOptions = {
  peers: string[];
  localStorage: false;
};

export type SeedPeerEmitter = {
  on: (event: string, cb: (peer?: unknown) => void) => unknown;
};

/**
 * Build the same-origin `/gun` peer from a page origin.
 * `http://localhost:3000` → `http://localhost:3000/gun`
 * `https://s3r.ch` → `https://s3r.ch/gun`
 *
 * Do not hardcode an App Service hostname. Same-origin follows whatever
 * host the page is on.
 */
export function sameOriginGunPeerUrl(origin: string): string {
  return new URL(GUN_PEER_PATH, origin).href;
}

/** Constructor options for `gun/browser`. Radisk stays at Gun's browser default. */
export function browserGunOptions(origin: string): BrowserGunOptions {
  return {
    peers: [sameOriginGunPeerUrl(origin)],
    localStorage: false,
  };
}

export function peerStatusLine(seedWsUp: boolean): string {
  return seedWsUp ? SEED_PEER_WS_STATUS : SNAPSHOT_ONLY_STATUS;
}

/**
 * Subscribe to Gun mesh hi/bye. Does not open a socket — the caller owns
 * the Gun instance. Used so `/feed` can say seed peer (ws) vs snapshot only
 * without claiming a P2P mesh.
 */
export function attachSeedPeerStatus(
  gun: SeedPeerEmitter,
  onStatus: (up: boolean) => void,
): void {
  gun.on("hi", () => onStatus(true));
  gun.on("bye", () => onStatus(false));
}
