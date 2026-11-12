import { OAUTH_REDIRECT_URIS } from "./config";
import { requestHost, requestIsSecure } from "../request-origin";
import { getIdentitySecret } from "./secret";
import { configuredIdentityReplay } from "./spanopticon-replay-server";
import { identitySessionNamespace } from "./replay-namespace";
import { createIdentitySessions } from "./sea-session";
import { createIdentityTokenVerifier } from "./sea-session-verifier";
import { createSeaSessionHandlers, readSeaSessionCookie } from "./sea-session-http";

const origins = new Set(OAUTH_REDIRECT_URIS.map(uri => new URL(uri).origin).filter(origin => origin.startsWith("https://")));
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie, Origin", "X-Content-Type-Options": "nosniff" };
const reply = (status: number, body: unknown) => Response.json(body, { status, headers });

/** Shared identity route: no Squad config, ledger, owner grant or Blob client. */
export async function siteSeaSession(request: Request, action: string, env: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: typeof fetch = fetch, clock = () => Math.floor(Date.now() / 1000)) {
  if (!((request.method === "GET" && action === "session") ||
      (request.method === "POST" && ["challenge", "exchange", "logout"].includes(action)))) return reply(404, { error: "not-found" });
  try {
    const origin = "https://" + requestHost(request);
    if (!requestIsSecure(request) || !origins.has(origin)) return reply(403, { error: "origin" });
    const replay = configuredIdentityReplay(identitySessionNamespace(origin), env, fetcher, clock);
    if (!replay) return request.method === "GET" ? reply(200, { enabled: false, principal: null }) : reply(503, { error: "identity-unavailable" });
    const secret = getIdentitySecret({ ...env, NODE_ENV: "production" });
    if (request.method === "GET") {
      const token = readSeaSessionCookie(request);
      try {
        const claims = token ? await createIdentityTokenVerifier({ origin, secret, clock }).claims(token, "s3rch-identity-session-v1", 300) : null;
        return reply(200, { enabled: true, principal: claims?.key ?? null, expiresAt: claims ? claims.expiresAt * 1000 : null });
      } catch { return reply(200, { enabled: true, principal: null, expiresAt: null }); }
    }
    const sessions = createIdentitySessions({ origin, secret, clock, consume: replay.consume, challengeDomain: replay.challengeDomain });
    const handlers = createSeaSessionHandlers({ origin, sessions });
    return handlers[action as "challenge" | "exchange" | "logout"](request);
  } catch { return reply(503, { error: "identity-unavailable" }); }
}
