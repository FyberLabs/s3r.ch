import { matchesRequestOrigin } from "../request-origin";
import { beginStartupOAuth, finishStartupOAuth, readStartupCredential } from "./startup-oauth";
import { readStartupLoginConfig } from "./startup-login-config";
import { startupPendingName, startupCredentialName } from "./startup-login-cookies";
import { getIdentitySecret } from "./secret";
import { createTerminalHttpAuthority, parseTerminalScope } from "./terminal-run-client";
import { withTerminalRun } from "./terminal-run";
const origin = new URL("https://test.s3r.ch");
const refused = () => Response.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
function issued(response: Response, name: string) {
  return response.headers.getSetCookie().some(cookie => cookie.startsWith(name + "=") &&
    cookie.slice(name.length + 1).split(";")[0].length > 0 && !cookie.includes("Max-Age=0"));
}
type Dependencies = NonNullable<Parameters<typeof beginStartupOAuth>[2]>;
/** Explicit native startup composition. No app imports, environment read or fixture
 * installation. The default config reader retains its private-file validation. */
export function createTerminalStartupRoute(input: { serviceKey: string; scope: unknown; env: Record<string, string | undefined> }, dependencies: Dependencies = {}) {
  const scope = parseTerminalScope(input.scope), env = Object.freeze({ ...input.env }), serviceKey = input.serviceKey;
  if (!/^[a-f0-9]{64}$/.test(serviceKey) || scope.suite !== "flags-s3rch-browser" || !scope.identities.sea.length) throw Error("Terminal startup configuration unavailable");
  getIdentitySecret({ ...env, NODE_ENV: "production" });
  const native = { ...dependencies }, fetcher = native.fetch ?? fetch;
  async function config() {
    const value = await (native.config ? native.config() : readStartupLoginConfig(env));
    if (!value || value.endpoint !== "https://api.test.hyperme.sh/auth/startup/identity" ||
        value.binding.tenant_id !== scope.tenant || !scope.identities.sea.includes(value.binding.sea_public_key) ||
        value.provider.issuer !== scope.issuer || !scope.clients.includes(value.provider.clientId) ||
        value.provider.authorizationEndpoint !== scope.issuer + "/protocol/openid-connect/auth" ||
        value.provider.tokenEndpoint !== scope.issuer + "/protocol/openid-connect/token" ||
        value.provider.jwksUri !== scope.issuer + "/protocol/openid-connect/certs") throw Error("Terminal startup configuration unavailable");
    return value;
  }
  return async (request: Request): Promise<Response> => {
    try {
      if (!matchesRequestOrigin(request, origin) || request.method !== "GET") return refused();
      const path = new URL(request.url).pathname;
      if (!["/api/identity/startup/start", "/api/identity/startup/session", "/api/identity/startup/availability", "/api/identity/oauth/callback"].includes(path)) return refused();
      const configured = await config(), deps = { ...native, config, fetch: fetcher };
      const authority = createTerminalHttpAuthority({ serviceKey, scopes: [scope] }, fetcher);
      return await withTerminalRun(request, authority, async () => {
        if (path.endsWith("/start")) return beginStartupOAuth(request, env, deps);
        if (path.endsWith("/callback")) return finishStartupOAuth(request, env, deps);
        if (path.endsWith("/availability")) return Response.json({ enabled: true }, { headers: { "Cache-Control": "no-store" } });
        const value = await readStartupCredential(request, env, deps);
        return Response.json(value ?? { error: "unavailable" }, { status: value ? 200 : 401, headers: { "Cache-Control": "no-store" } });
      }, response => {
        if (response.status === 200) return true;
        if (response.status !== 302) return false;
        const location = response.headers.get("location");
        if (path.endsWith("/callback")) return location === "/feed?startup=linked" && issued(response, startupCredentialName(true));
        if (!path.endsWith("/start") || !location || !issued(response, startupPendingName(true))) return false;
        const target = new URL(location);
        return target.origin + target.pathname === configured.provider.authorizationEndpoint && target.searchParams.get("client_id") === configured.provider.clientId &&
          target.searchParams.get("redirect_uri") === origin.origin + "/api/identity/oauth/callback";
      });
    } catch { return refused(); }
  };
}
