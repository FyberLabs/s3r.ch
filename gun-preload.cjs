/**
 * Attach a same-process Gun seed peer to Next's HTTP server before listen().
 * Gun serves WebSocket at `/gun`. Bootstrap cache — not the finished mesh
 * (docs/ARCHITECTURE.md). Used as `node -r ./gun-preload.cjs server.js`.
 */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const gunFile = process.env.GUN_FILE || path.join(process.cwd(), "data", "radata");
const snapshotFile =
  process.env.GUN_SNAPSHOT || path.join(process.cwd(), "data", "snapshot.json");
fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
fs.mkdirSync(gunFile, { recursive: true });

const origListen = http.Server.prototype.listen;
http.Server.prototype.listen = function patchedListen(...args) {
  if (!globalThis.__s3rchGun) {
    const Gun = require("gun");
    const factory = typeof Gun === "function" ? Gun : Gun.default;
    globalThis.__s3rchGun = factory({
      web: this,
      file: gunFile,
      multicast: false,
      axe: false,
      peers: [],
    });
    console.log("[s3r.ch] Gun peer attached to HTTP server, file=", gunFile);
  }
  return origListen.apply(this, args);
};
