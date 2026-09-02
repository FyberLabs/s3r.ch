/**
 * Same-origin Gun seed peer for the browser. Azure App Service is a seed
 * peer + bootstrap cache, not the chat server. WebRTC / ICE / TURN are not
 * this slice. Do not call user.recall({ sessionStorage: true }).
 *
 * Gun 0.2020.1241 mesh emits hi/bye on the root onto (`gun._.on`), not the
 * graph `.on`. `Gun({ peers })` starts the wire immediately (websocket.js
 * `onopen` → `mesh.hi` → `root.on('hi', peer)`), so `/feed` must listen
 * before `opt({ peers })`.
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
export const GUN_EMPTY_COPY = "Gun is empty. Nothing was invented.";

export type BrowserGunOptions = {
  localStorage: false;
};

export type SeedPeerConnectOptions = {
  peers: string[];
};

/** Root onto: subscribe when `arg` is a function, emit when it is a message. */
export type SeedPeerOnto = (
  event: string,
  arg?: ((peer?: unknown) => void) | object,
) => unknown;

export type SeedPeerEmitter = {
  on?: SeedPeerOnto;
  _?: { on?: SeedPeerOnto };
  back?: (n: number | string) => SeedPeerEmitter | { hi?: (peer: unknown) => unknown } | undefined;
  opt?: (opts: SeedPeerConnectOptions) => unknown;
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

/**
 * Constructor options for `gun/browser`. No peers — listen for mesh hi/bye
 * first, then `opt` the same-origin `/gun` URL. Radisk stays at Gun's
 * browser default.
 */
export function browserGunOptions(_origin?: string): BrowserGunOptions {
  return {
    localStorage: false,
  };
}

/** `gun.opt` payload that opens the same-origin `/gun` peer after listen. */
export function seedPeerConnectOptions(origin: string): SeedPeerConnectOptions {
  return {
    peers: [sameOriginGunPeerUrl(origin)],
  };
}

export function peerStatusLine(seedWsUp: boolean): string {
  return seedWsUp ? SEED_PEER_WS_STATUS : SNAPSHOT_ONLY_STATUS;
}

/**
 * `/feed` status after the snapshot returns. `seedWsUp` stays source of
 * truth: a live wire is **seed peer (ws)** even when the graph is empty.
 * Empty snapshot without a wire still says nothing was invented.
 */
export function feedStatusLine(
  seedWsUp: boolean,
  snapshotEmpty: boolean,
): string {
  if (seedWsUp) return SEED_PEER_WS_STATUS;
  if (snapshotEmpty) return `${SNAPSHOT_ONLY_STATUS}. ${GUN_EMPTY_COPY}`;
  return SNAPSHOT_ONLY_STATUS;
}

/**
 * Mesh onto for this Gun 0.2020.1241 build. `src/mesh.js` does
 * `root.on('hi', peer)` on the root context (`gun._`), not `Gun.on('hi')`
 * and not graph `gun.on(cb)`. `gun.back(-1)._.on` is the same onto from a
 * chain. Fall back to `gun.on('hi', cb)` (chain string-tag path) for tests.
 */
export function meshHiByeOn(
  gun: SeedPeerEmitter,
): SeedPeerOnto | undefined {
  const rootOnto = gun._?.on;
  if (typeof rootOnto === "function") {
    return rootOnto.bind(gun._);
  }
  const root = typeof gun.back === "function" ? gun.back(-1) : undefined;
  const viaBack =
    root && typeof root === "object" && "_" in root
      ? (root as SeedPeerEmitter)._.on
      : undefined;
  if (typeof viaBack === "function") {
    return viaBack.bind((root as SeedPeerEmitter)._);
  }
  if (typeof gun.on === "function") {
    return gun.on.bind(gun);
  }
  return undefined;
}

/**
 * Subscribe to Gun mesh hi/bye on the onto mesh.js actually emits.
 * Does not open a socket — the caller owns connect. Used so `/feed` can
 * say seed peer (ws) vs snapshot only without claiming a P2P mesh.
 */
export function attachSeedPeerStatus(
  gun: SeedPeerEmitter,
  onStatus: (up: boolean) => void,
): void {
  const on = meshHiByeOn(gun);
  if (typeof on !== "function") return;
  on("hi", () => onStatus(true));
  on("bye", () => onStatus(false));
}

/**
 * websocket.js sends `{dam:'hi'}` on first create only (`root.once`
 * skips later `Gun.on('opt')`). After a late `opt({ peers })`, emit
 * the same out so `mesh.say` calls `mesh.wire` and the socket opens.
 */
export function kickSeedPeerWire(gun: SeedPeerEmitter): void {
  const onto = gun._?.on;
  if (typeof onto === "function") {
    onto.call(gun._, "out", { dam: "hi" });
  }
}

/**
 * Listen for mesh hi/bye, then open the same-origin `/gun` peer.
 * `opt({ peers })` is how this Gun version adds peers after create
 * (`test/panic/s2s-all-delayed-peer-add.js`). A hi that fires inside
 * `opt` is still heard.
 */
export function listenThenConnectSeedPeer(
  gun: SeedPeerEmitter,
  origin: string,
  onStatus: (up: boolean) => void,
): void {
  attachSeedPeerStatus(gun, onStatus);
  if (typeof gun.opt === "function") {
    gun.opt(seedPeerConnectOptions(origin));
  }
  kickSeedPeerWire(gun);
}
