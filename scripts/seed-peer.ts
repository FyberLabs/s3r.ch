// Optional standalone bootstrap origin. Use a single writer per Gun volume.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { POST as seed } from "../app/api/seed/route";
import { attachGunWeb, snapshotPath } from "../lib/gun-server";
import { restorePublicFeed } from "../public-feed-cache.cjs";

if (process.env.GUN_EXTERNAL_PEER === "1") throw new Error("GUN_EXTERNAL_PEER is for the web process only.");
const snapshot = "public/feed-cache/snapshot.json";
restorePublicFeed(process.cwd(), snapshotPath());

async function serve(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/api/seed" && request.method === "POST") {
    if (!process.env.SEED_SECRET) {
      response.writeHead(503).end();
      return;
    }
    const result = await seed(new Request("http://localhost/api/seed", {
      method: "POST", headers: { authorization: request.headers.authorization ?? "" },
    }));
    response.writeHead(result.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(await result.text());
    return;
  }
  if (request.method === "GET" || request.method === "HEAD") {
    if (url.pathname === "/api/health") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end('{"status":"ok","dependencies":{"gun":{"status":"ok"}}}');
      return;
    }
    if (url.pathname === "/feed-cache/snapshot.json" || url.pathname === "/api/feed") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" });
      if (request.method === "HEAD") response.end();
      else await pipeline(createReadStream(snapshot), response);
      return;
    }
  }
  response.writeHead(404).end();
}

const server = createServer((request, response) => {
  void serve(request, response).catch(() => {
    if (response.headersSent) response.destroy();
    else response.writeHead(500).end();
  });
});
attachGunWeb(server);
server.listen(Number(process.env.PORT || 8080), process.env.HOSTNAME || "0.0.0.0");
