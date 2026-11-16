import { matchesRequestOrigin } from "../request-origin";
import { parseTerminalOwnerConfig } from "./terminal-owner-config";
import { createTerminalOwnerControl } from "./terminal-owner-control";
import { createTerminalFixturePolicy } from "./terminal-fixture-policy";
import { createTerminalDeviceRoute } from "./terminal-device-route";
import { createTerminalSeaRoute } from "./terminal-sea-route";
import { createTerminalStartupRoute } from "./terminal-startup-route";
import { createTerminalExperimentRoute } from "./terminal-experiment-route";
import { createTerminalHttpAuthority } from "./terminal-run-client";
import { withTerminalRun } from "./terminal-run";
const refused = () => Response.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
const seaPath = (path: string) => /^\/api\/identity\/sea\/(session|challenge|exchange|logout)$/.test(path) || /^\/api\/squad\/pilot\/session\/(challenge|exchange|logout)$/.test(path);
const auxiliary = (request: Request, path: string) => request.method === "GET" && ["/api/identity/session", "/api/identity/oauth/session", "/api/identity/providers"].includes(path) ||
  request.method === "POST" && path === "/api/identity/logout";
/** Uninstalled top-level native dispatcher. The native callback is the application's
 * ordinary handler/renderer, always enclosed by fixture policy. Do not install
 * only selected identity routes: doing so would leave a missing-grant bypass. */
export async function createTerminalServingRouter(input: { config: string; env: Record<string, string | undefined>; experimentsEnabled: boolean },
  native: (request: Request) => Promise<Response>, fetcher: typeof fetch = fetch) {
  const config = parseTerminalOwnerConfig(input.config), env = Object.freeze({ ...input.env }), origin = new URL(config.origin);
  const scopes = Object.values(config.scopes), policy = createTerminalFixturePolicy(scopes), serviceKey = config.ownerKey;
  const control = createTerminalOwnerControl(input.config, fetcher);
  const device = createTerminalDeviceRoute({ serviceKey, scope: config.scopes["s3rch-device-transfer"], env }, fetcher);
  // One authority accepts either exact registered suite. Never try one admission
  // and then another: the first could leave an orphan pending operation.
  const sea = createTerminalSeaRoute({ serviceKey, scope: scopes, env }, fetcher);
  const startup = createTerminalStartupRoute({ serviceKey, scope: config.scopes["flags-s3rch-browser"], env }, { fetch: fetcher });
  const experiment = await createTerminalExperimentRoute({ serviceKey, scope: config.scopes["flags-s3rch-browser"], env, enabled: input.experimentsEnabled }, fetcher);
  let closed = false;
  return Object.freeze({
    async request(request: Request): Promise<Response> {
      try {
        if (closed || !matchesRequestOrigin(request, origin)) return refused();
        const path = new URL(request.url).pathname, cookies = request.headers.get("cookie") ?? "";
        if (cookies.length > 16384) return refused();
        if (path === "/api/internal/nightly-run") return control(request);
        const grant = cookies.split(";").some(cookie => cookie.trim().startsWith("__Host-nightly-run-grant="));
        return await policy(async () => {
          if (path === "/api/experiments" || path.startsWith("/api/experiments/")) return grant ? experiment.request(request) : refused();
          if (path.startsWith("/api/identity/device/")) return grant ? device(request) : refused();
          if (path.startsWith("/api/identity/startup/") || path === "/api/identity/oauth/callback") return grant ? startup(request) : refused();
          if (seaPath(path)) return grant ? sea(request) : native(request);
          if (auxiliary(request, path)) {
            if (!grant) return native(request);
            if (request.method === "POST" && request.headers.get("origin") !== origin.origin) return refused();
            const authority = createTerminalHttpAuthority({ serviceKey, scopes }, fetcher);
            return withTerminalRun(request, authority, () => native(request), response => response.status === 200 || request.method === "GET" && response.status === 401);
          }
          // Unsupported wallet/link/delegation mutations are unavailable under
          // TEST owner configuration; never invent a wallet-to-SEA fixture map.
          if (path.startsWith("/api/identity/") || grant && path.startsWith("/api/")) return refused();
          return native(request);
        });
      } catch { return refused(); }
    },
    async close() { closed = true; await experiment.close(); },
  });
}
