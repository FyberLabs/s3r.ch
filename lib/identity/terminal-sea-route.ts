import { matchesRequestOrigin } from "../request-origin";
import { createTerminalHttpAuthority, parseTerminalScope } from "./terminal-run-client";
import { siteSeaSession } from "./site-sea-session-server";
import { configuredIdentityReplay } from "./spanopticon-replay-server";
import { identitySessionNamespace } from "./replay-namespace";
import { getIdentitySecret } from "./secret";
import { withTerminalRun } from "./terminal-run";
const origin = new URL("https://test.s3r.ch");
const refused = () => Response.json({ error: "identity-unavailable" }, { status: 503,
  headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
/** Uninstalled native SEA composition, including the existing Squad session
 * alias. Linked identity requires its separate complete owner source and is not
 * admitted by this factory. No routes, secrets or capabilities are installed. */
export function createTerminalSeaRoute(input: { serviceKey: string; scope: unknown;
  env: Record<string, string | undefined> }, fetcher: typeof fetch = fetch) {
  const env = Object.freeze({ ...input.env }), scope = parseTerminalScope(input.scope), serviceKey = input.serviceKey;
  if (!/^[a-f0-9]{64}$/.test(serviceKey) || !scope.identities.sea.length ||
      env.S3RCH_IDENTITY_REPLAY_ORIGIN !== "https://api.test.hyperme.sh" ||
      env.S3RCH_IDENTITY_REPLAY_TENANT_ID !== scope.tenant ||
      !configuredIdentityReplay(identitySessionNamespace(origin.origin), env, fetcher)) throw Error("Terminal SEA configuration unavailable");
  getIdentitySecret({ ...env, NODE_ENV: "production" });
  return async (request: Request): Promise<Response> => {
    try {
      if (!matchesRequestOrigin(request, origin)) return refused();
      const path = new URL(request.url).pathname;
      const action = path.match(/^\/api\/identity\/sea\/(session|challenge|exchange|logout)$/)?.[1] ??
        path.match(/^\/api\/squad\/pilot\/session\/(challenge|exchange|logout)$/)?.[1];
      if (!action || (action === "session" ? request.method !== "GET" :
          request.method !== "POST" || request.headers.get("origin") !== origin.origin)) return refused();
      const authority = createTerminalHttpAuthority({ serviceKey, scopes: [scope] }, fetcher);
      return await withTerminalRun(request, authority, () => siteSeaSession(request, action, env, fetcher),
        response => response.status === 200);
    } catch { return refused(); }
  };
}
