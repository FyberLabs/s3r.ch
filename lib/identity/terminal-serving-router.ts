import { terminalRouteKind, terminalGrantPresent } from "./terminal-route-policy";
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
        const kind = terminalRouteKind(request), cookies = request.headers.get("cookie") ?? "";
        if (cookies.length > 16384) return refused();
        if (kind === "control") return control(request);
        const grant = terminalGrantPresent(request);
        return await policy(async () => {
          if (kind === "experiment") return grant ? experiment.request(request) : refused();
          if (kind === "device") return grant ? device(request) : refused();
          if (kind === "startup") return grant ? startup(request) : refused();
          if (kind === "sea") return grant ? sea(request) : native(request);
          if (kind === "auxiliary") {
            if (!grant) return native(request);
            if (request.method === "POST" && request.headers.get("origin") !== origin.origin) return refused();
            const authority = createTerminalHttpAuthority({ serviceKey, scopes }, fetcher);
            return withTerminalRun(request, authority, () => native(request), response => response.status === 200 || request.method === "GET" && response.status === 401);
          }
          // Unsupported wallet/link/delegation mutations are unavailable under
          // TEST owner configuration; never invent a wallet-to-SEA fixture map.
          if (kind === "unsupported" || grant && kind === "api") return refused();
          return native(request);
        });
      } catch { return refused(); }
    },
    async close() { closed = true; await experiment.close(); },
  });
}
