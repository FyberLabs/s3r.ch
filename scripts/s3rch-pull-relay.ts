/**
 * Thin 127.0.0.1 relay for local http pages.
 * Allowlisted documented sources only. Not a general proxy.
 * Mixed content blocks this from https://s3r.ch — use the MV3 extension there.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseIngestRequest } from "../lib/browser-pull";
import { queryNostrRelay } from "../lib/nostr";
import {
  PULL_RELAY_CHANNEL,
  PULL_RELAY_LOCAL_HOST,
  PULL_RELAY_LOCAL_PATH,
  PULL_RELAY_LOCAL_PORT,
  PULL_RELAY_PROTOCOL_V,
  executePullRelay,
  isPullRelayPageOrigin,
  nodePullRelayFetch,
  parsePullRelayMessage,
  pullRelayDenied,
  pullRelayReady,
} from "../lib/pull-relay";

const PATH_HELLO = `${PULL_RELAY_LOCAL_PATH}/hello`;
const PATH_PULL = `${PULL_RELAY_LOCAL_PATH}/pull`;

const server = createServer((req, res) => {
  void handle(req, res);
});

server.listen(PULL_RELAY_LOCAL_PORT, PULL_RELAY_LOCAL_HOST, () => {
  console.log(
    `s3rch-pull relay on http://${PULL_RELAY_LOCAL_HOST}:${PULL_RELAY_LOCAL_PORT}${PULL_RELAY_LOCAL_PATH}`,
  );
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = req.headers.origin;
  if (typeof origin === "string" && !isPullRelayPageOrigin(origin)) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify(pullRelayDenied("Origin is not allowed.")));
    return;
  }
  const cors: Record<string, string> = {
    "content-type": "application/json",
    vary: "Origin",
  };
  if (typeof origin === "string") {
    cors["access-control-allow-origin"] = origin;
    cors["access-control-allow-methods"] = "GET, POST, OPTIONS";
    cors["access-control-allow-headers"] = "content-type";
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${PULL_RELAY_LOCAL_HOST}`);
  if (req.method === "GET" && url.pathname === PATH_HELLO) {
    res.writeHead(200, cors);
    res.end(JSON.stringify(pullRelayReady("localhost")));
    return;
  }
  if (req.method === "POST" && url.pathname === PATH_PULL) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, cors);
      res.end(JSON.stringify(pullRelayDenied("Expected JSON.")));
      return;
    }
    const parsed = parsePullRelayMessage(body);
    if (parsed.kind === "invalid") {
      res.writeHead(400, cors);
      res.end(JSON.stringify(pullRelayDenied(parsed.error)));
      return;
    }
    if (parsed.kind !== "pull") {
      res.writeHead(400, cors);
      res.end(JSON.stringify(pullRelayDenied("Expected a pull.")));
      return;
    }
    const ingest = parseIngestRequest(parsed.message.body);
    if (ingest.kind === "invalid") {
      res.writeHead(400, cors);
      res.end(JSON.stringify(pullRelayDenied(ingest.error, parsed.message.id)));
      return;
    }
    const executed = await executePullRelay(parsed.message.body, {
      fetchText: nodePullRelayFetch,
      queryNostr: queryNostrRelay,
    });
    if (executed.kind === "denied") {
      res.writeHead(400, cors);
      res.end(JSON.stringify(pullRelayDenied(executed.error, parsed.message.id)));
      return;
    }
    res.writeHead(executed.sourcesOk === 0 ? 502 : 200, cors);
    res.end(
      JSON.stringify({
        channel: PULL_RELAY_CHANNEL,
        type: "result",
        v: PULL_RELAY_PROTOCOL_V,
        id: parsed.message.id,
        items: executed.items,
        fetches: executed.fetches,
        sourcesOk: executed.sourcesOk,
        sourcesTried: executed.sourcesTried,
        error: executed.error,
      }),
    );
    return;
  }

  res.writeHead(404, cors);
  res.end(JSON.stringify(pullRelayDenied("Not found.")));
}
