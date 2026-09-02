import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  attachSeedPeerStatus,
  browserGunOptions,
  GUN_PEER_PATH,
  peerStatusLine,
  sameOriginGunPeerUrl,
  SEED_PEER_WS_STATUS,
  SNAPSHOT_ONLY_STATUS,
  TRYING_SEED_COPY,
} from "./gun-peer";

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
    const src = readFileSync(new URL("./gun-peer.ts", import.meta.url), "utf8");
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
  it("peers the same-origin /gun URL and disables localStorage", () => {
    const opts = browserGunOptions("https://s3r.ch");
    assert.deepEqual(opts.peers, ["https://s3r.ch/gun"]);
    assert.equal(opts.localStorage, false);
    assert.equal("sessionStorage" in opts, false);
    assert.equal("webrtc" in opts, false);
    assert.equal("ice" in opts, false);
    assert.equal("iceServers" in opts, false);
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

  it("notifies hi/bye without opening a live socket", () => {
    const seen: boolean[] = [];
    const listeners = new Map<string, Array<(peer?: unknown) => void>>();
    const fake = {
      on(event: string, cb: (peer?: unknown) => void) {
        const list = listeners.get(event) ?? [];
        list.push(cb);
        listeners.set(event, list);
        return fake;
      },
    };
    attachSeedPeerStatus(fake, (up) => seen.push(up));
    listeners.get("hi")?.forEach((cb) => cb({}));
    listeners.get("bye")?.forEach((cb) => cb({}));
    assert.deepEqual(seen, [true, false]);
  });
});
