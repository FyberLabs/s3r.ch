import { matchesRequestOrigin } from "../request-origin";
import { createExperimentApplication } from "../experiment-application";
import { createTerminalHttpAuthority, parseTerminalScope } from "./terminal-run-client";
import { withTerminalRun } from "./terminal-run";
const origin = new URL("https://test.s3r.ch");
const refused = () => Response.json({ error: "Experiment service unavailable" }, { status: 503,
  headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
/** Uninstalled composition of native consent/display/outbox delivery. No app
 * route registration, process configuration reads or automatic activation. */
export async function createTerminalExperimentRoute(input: { serviceKey: string; scope: unknown;
  env: Record<string, string | undefined>; enabled: boolean }, transport: typeof fetch = fetch) {
  const env = Object.freeze({ ...input.env }), scope = parseTerminalScope(input.scope), serviceKey = input.serviceKey, enabled = input.enabled;
  if (!/^[a-f0-9]{64}$/.test(serviceKey) || typeof enabled !== "boolean" || scope.suite !== "flags-s3rch-browser" ||
      env.S3RCH_EXPERIMENT_ORIGIN !== origin.origin ||
      env.S3RCH_EXPERIMENT_STORAGE_ORIGIN !== "https://api.test.hyperme.sh") throw Error("Terminal experiment configuration unavailable");
  // Native configuration owns the product-record tenant; the identity scope
  // must not select or overwrite that independent storage namespace.
  const app = await createExperimentApplication(env, transport);
  let closed = false;
  return Object.freeze({
    async request(request: Request): Promise<Response> {
      try {
        if (closed || !matchesRequestOrigin(request, origin) || new URL(request.url).pathname !== "/api/experiments" ||
            !["GET", "POST"].includes(request.method) || request.method === "POST" && request.headers.get("origin") !== origin.origin) return refused();
        const authority = createTerminalHttpAuthority({ serviceKey, scopes: [scope] }, transport);
        const result = await withTerminalRun(request, authority, async () => {
          if (closed) throw Error("Experiment route closed");
          const response = await (request.method === "GET" ? app.get(request, enabled) : app.post(request, enabled));
          // A native 200 can report an unverified withdrawal. Preserve pending
          // admission rather than treating cookie clearing as deletion evidence.
          const payload = response.status === 200 ? await response.clone().json() : null;
          return { response, confirmed: response.status === 200 && payload?.withdrawalVerified !== false };
        }, result => result.confirmed);
        return result.response;
      } catch { return refused(); }
    },
    async close() { closed = true; await app.close(); },
  });
}
