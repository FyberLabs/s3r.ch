import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  attachSeedPeerStatus,
  browserGunOptions,
  feedStatusLine,
  GUN_EMPTY_COPY,
  GUN_PEER_PATH,
  isSeedWirePeer,
  listenThenConnectSeedPeer,
  meshHiByeOn,
  peerStatusLine,
  sameOriginGunPeerUrl,
  seedPeerConnectOptions,
  SEED_PEER_WS_STATUS,
  SNAPSHOT_ONLY_STATUS,
  TRYING_SEED_COPY,
  type SeedPeerOnto,
} from "./gun-peer";
import {
  GOOGLE_STUN_URL,
  isStunOnlyIceServer,
  WEBRTC_ATTEMPTED_HINT,
} from "./gun-webrtc";

function helperSource(): string {
  return readFileSync(new URL("./gun-peer.ts", import.meta.url), "utf8");
}

/** SeedPeerOnto's second arg is subscribe-or-emit; tests only keep the listener. */
function ontoListener(
  arg: Parameters<SeedPeerOnto>[1],
): ((peer?: unknown) => void) | undefined {
  return typeof arg === "function" ? (arg as (peer?: unknown) => void) : undefined;
}

describe("sameOriginGunPeerUrl", () => {
  it("builds localhost http /gun from the page origin", () => {
    assert.equal(
      sameOriginGunPeerUrl("http://localhost:3000"),
      "http://localhost:3000/gun",
    );
    assert.equal(
      sameOriginGunPeerUrl("http://127.0.0.1:8080"),
      "http://127.0.0.1:8080/gun",
    );
  });

  it("builds https s3r.ch /gun from the page origin", () => {
    assert.equal(sameOriginGunPeerUrl("https://s3r.ch"), "https://s3r.ch/gun");
    assert.equal(
      sameOriginGunPeerUrl("https://s3r.ch/"),
      "https://s3r.ch/gun",
    );
  });

  it("does not hardcode azurewebsites.net; same-origin follows the given host", () => {
    const src = helperSource();
    assert.equal(src.includes("azurewebsites.net"), false);
    assert.equal(
      sameOriginGunPeerUrl("https://s3r.ch").includes("azurewebsites.net"),
      false,
    );
    assert.equal(
      sameOriginGunPeerUrl("https://example.com"),
      "https://example.com/gun",
    );
  });

  it("keeps the /gun path Gun's ws adapter actually mounts", () => {
    assert.equal(GUN_PEER_PATH, "/gun");
  });
});

describe("browserGunOptions", () => {
  it("disables localStorage and does not open a peer at construct", () => {
    const opts = browserGunOptions("https://s3r.ch");
    assert.equal(opts.localStorage, false);
    assert.equal("peers" in opts, false);
    assert.equal("sessionStorage" in opts, false);
    assert.equal("webrtc" in opts, false);
    assert.deepEqual(opts.rtc.iceServers, [{ urls: GOOGLE_STUN_URL }]);
    assert.equal(isStunOnlyIceServer(opts.rtc.iceServers[0]), true);
  });

  it("adds STUN-only rtc and still forbids recall and TURN", () => {
    const src = helperSource();
    assert.equal(src.includes("stunOnlyRtcOptions"), true);
    assert.equal(src.includes("user.recall({ sessionStorage: true })"), true);
    assert.equal(/urls:\s*['"]turns?:/.test(src), false);
    const webrtcSrc = readFileSync(
      new URL("./gun-webrtc.ts", import.meta.url),
      "utf8",
    );
    assert.equal(webrtcSrc.includes("gun/lib/webrtc"), true);
  });
});

describe("seedPeerConnectOptions", () => {
  it("opts the same-origin /gun URL after listen", () => {
    assert.deepEqual(seedPeerConnectOptions("https://s3r.ch"), {
      peers: ["https://s3r.ch/gun"],
    });
  });
});

describe("peer status copy", () => {
  it("distinguishes seed peer (ws) from snapshot only without claiming mesh", () => {
    assert.equal(peerStatusLine(true), "seed peer (ws)");
    assert.equal(peerStatusLine(false), "snapshot only");
    assert.equal(SEED_PEER_WS_STATUS, "seed peer (ws)");
    assert.equal(SNAPSHOT_ONLY_STATUS, "snapshot only");
    assert.equal(
      TRYING_SEED_COPY,
      "Trying seed peer; snapshot if the socket is down",
    );
    assert.equal(TRYING_SEED_COPY.toLowerCase().includes("mesh"), false);
    assert.equal(peerStatusLine(true).toLowerCase().includes("mesh"), false);
    assert.equal(peerStatusLine(false).toLowerCase().includes("p2p"), false);
  });

  it("keeps seed peer (ws) when the graph is empty; empty snapshot is honest", () => {
    assert.equal(feedStatusLine(true, true), "seed peer (ws)");
    assert.equal(feedStatusLine(true, false), "seed peer (ws)");
    assert.equal(feedStatusLine(false, false), "snapshot only");
    assert.equal(
      feedStatusLine(false, true),
      "snapshot only. Gun is empty. Nothing was invented.",
    );
    assert.equal(GUN_EMPTY_COPY, "Gun is empty. Nothing was invented.");
  });

  it("appends a quiet WebRTC-attempted hint without claiming a mesh", () => {
    assert.equal(
      feedStatusLine(true, false, true),
      `${SEED_PEER_WS_STATUS} · ${WEBRTC_ATTEMPTED_HINT}`,
    );
    assert.equal(
      feedStatusLine(false, false, true),
      `${SNAPSHOT_ONLY_STATUS} · ${WEBRTC_ATTEMPTED_HINT}`,
    );
    assert.equal(feedStatusLine(true, false, false), SEED_PEER_WS_STATUS);
    assert.equal(feedStatusLine(true, false, true).toLowerCase().includes("mesh"), false);
    assert.equal(feedStatusLine(true, false, true).toLowerCase().includes("p2p"), false);
  });

  it("notifies hi/bye on mesh onto without opening a live socket", () => {
    const seen: boolean[] = [];
    const listeners = new Map<string, Array<(peer?: unknown) => void>>();
    const fake = {
      _: {
        on(event: string, arg?: Parameters<SeedPeerOnto>[1]) {
          const cb = ontoListener(arg);
          if (!cb) return fake._;
          const list = listeners.get(event) ?? [];
          list.push(cb);
          listeners.set(event, list);
          return fake._;
        },
      },
    };
    attachSeedPeerStatus(fake, (up) => seen.push(up));
    listeners.get("hi")?.forEach((cb) => cb({ url: "https://s3r.ch/gun" }));
    listeners.get("bye")?.forEach((cb) => cb({ url: "https://s3r.ch/gun" }));
    assert.deepEqual(seen, [true, false]);
  });

  it("ignores WebRTC mesh hi/bye so seed peer (ws) stays the socket", () => {
    const seen: boolean[] = [];
    const listeners = new Map<string, Array<(peer?: unknown) => void>>();
    const fake = {
      _: {
        on(event: string, arg?: Parameters<SeedPeerOnto>[1]) {
          const cb = ontoListener(arg);
          if (!cb) return fake._;
          const list = listeners.get(event) ?? [];
          list.push(cb);
          listeners.set(event, list);
          return fake._;
        },
      },
    };
    attachSeedPeerStatus(fake, (up) => seen.push(up));
    listeners.get("hi")?.forEach((cb) => cb({ createDataChannel() {} }));
    listeners.get("hi")?.forEach((cb) => cb({ url: "https://s3r.ch/gun" }));
    listeners.get("bye")?.forEach((cb) => cb({ createDataChannel() {} }));
    assert.deepEqual(seen, [true]);
    listeners.get("bye")?.forEach((cb) => cb({ url: "https://s3r.ch/gun" }));
    assert.deepEqual(seen, [true, false]);
    assert.equal(isSeedWirePeer({ url: "https://s3r.ch/gun" }), true);
    assert.equal(isSeedWirePeer({}), false);
    assert.equal(isSeedWirePeer({ createDataChannel() {} }), false);
  });

  it("prefers gun._.on (mesh onto) over graph gun.on", () => {
    const onto: string[] = [];
    const graph: string[] = [];
    const fake = {
      on(event: string) {
        graph.push(event);
        return fake;
      },
      _: {
        on(event: string) {
          onto.push(event);
          return fake._;
        },
      },
    };
    attachSeedPeerStatus(fake, () => {});
    assert.deepEqual(onto, ["hi", "bye"]);
    assert.deepEqual(graph, []);
    const bound = meshHiByeOn(fake);
    assert.equal(typeof bound, "function");
  });

  it("falls back to gun.back(-1)._.on when gun._ is missing", () => {
    const onto: string[] = [];
    const root = {
      _: {
        on(event: string, arg?: Parameters<SeedPeerOnto>[1]) {
          if (typeof arg === "function") onto.push(event);
          return root._;
        },
      },
    };
    const fake = {
      back() {
        return root;
      },
    };
    attachSeedPeerStatus(fake, () => {});
    assert.deepEqual(onto, ["hi", "bye"]);
  });
});

describe("listenThenConnectSeedPeer", () => {
  it("cannot miss a hi that fires as soon as peers are opted", () => {
    const seen: boolean[] = [];
    const listeners = new Map<string, Array<(peer?: unknown) => void>>();
    const outs: unknown[] = [];
    let opted: string[] | undefined;
    const fake = {
      _: {
        on(event: string, arg?: Parameters<SeedPeerOnto>[1]) {
          const cb = ontoListener(arg);
          if (!cb) {
            outs.push(arg);
            return fake._;
          }
          const list = listeners.get(event) ?? [];
          list.push(cb);
          listeners.set(event, list);
          return fake._;
        },
      },
      opt(opts: { peers: string[] }) {
        opted = opts.peers;
        listeners.get("hi")?.forEach((cb) => cb({ url: opts.peers[0] }));
        return fake;
      },
    };
    listenThenConnectSeedPeer(fake, "https://s3r.ch", (up) => seen.push(up));
    assert.deepEqual(opted, ["https://s3r.ch/gun"]);
    assert.deepEqual(seen, [true]);
    assert.deepEqual(outs, [{ dam: "hi" }]);
  });

  it("misses that same immediate hi if connect runs before listen (the race)", () => {
    const seen: boolean[] = [];
    const listeners = new Map<string, Array<(peer?: unknown) => void>>();
    const fake = {
      _: {
        on(event: string, arg?: Parameters<SeedPeerOnto>[1]) {
          const cb = ontoListener(arg);
          if (!cb) return fake._;
          const list = listeners.get(event) ?? [];
          list.push(cb);
          listeners.set(event, list);
          return fake._;
        },
      },
      opt(opts: { peers: string[] }) {
        listeners.get("hi")?.forEach((cb) => cb({ url: opts.peers[0] }));
        return fake;
      },
    };
    fake.opt({ peers: ["https://s3r.ch/gun"] });
    attachSeedPeerStatus(fake, (up) => seen.push(up));
    assert.deepEqual(seen, []);
  });
});
