// Standalone bootstrap origin. Use a single writer per Gun volume.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { GET as version } from "../app/api/version/route";
import { handleSeed as seed } from "../lib/seed-request";
import { attachGunWeb, snapshotPath } from "../lib/gun-server";
import { restoreTenantFeedCache } from "../lib/tenant-feed-cache-server";
import { restorePublicFeed } from "../public-feed-cache.cjs";
import { publicFeedTelemetry } from "../lib/feed-telemetry";
import { testOriginAllowed } from "../lib/test-origin-guard";

const snapshot = "public/feed-cache/snapshot.json";
restorePublicFeed(process.cwd(), snapshotPath());

async function serve(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!testOriginAllowed(process.env.S3RCH_TEST_ORIGIN_ID, request.headers["x-azure-fdid"], {
    method: request.method, pathname: url.pathname,
  })) {
    response.writeHead(403, { "Cache-Control": "no-store" }).end();
    return;
  }
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
    if (url.pathname === "/api/version") {
      const result = version();
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(request.method === "HEAD" ? undefined : await result.text());
      return;
    }
    if (url.pathname === "/api/health") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const includeTelemetry = url.searchParams.get("telemetry") === "1";
      response.end(JSON.stringify({
        status: "ok",
        dependencies: { gun: { status: "ok" } },
        ...(includeTelemetry ? { telemetry: { version: 1, feed: publicFeedTelemetry() } } : {}),
      }));
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
void restoreTenantFeedCache().catch(() => {
  console.error("[s3r.ch] Tenant feed cache unavailable; serving the last local snapshot");
});
server.listen(Number(process.env.PORT || 8080), process.env.HOSTNAME || "0.0.0.0");
