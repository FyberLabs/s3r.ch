import { matchesRequestOrigin } from "../request-origin";
import { deviceConfig } from "./device-config";
import { deviceServer } from "./device-server";
import { devicePendingCookie, devicePersonCookie } from "./device-cookies";
import { createTerminalHttpAuthority, parseTerminalScope } from "./terminal-run-client";
import { withTerminalRun } from "./terminal-run";

const origin = new URL("https://test.s3r.ch");
const refused = () => Response.json({ error: "unavailable" }, { status: 503,
  headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
function issued(response: Response, name: string) {
  return response.headers.getSetCookie().some(value => value.startsWith(name + "=") &&
    value.slice(name.length + 1).split(";")[0].length > 0 && !value.includes("Max-Age=0"));
}
/** Explicit, uninstalled native composition. No process environment reads, route
 * registration or capability publication. Complete fixture route classification
 * and controller composition are required before an app route may use this. */
export function createTerminalDeviceRoute(input: { serviceKey: string; scope: unknown;
  env: Record<string, string | undefined> }, fetcher: typeof fetch = fetch) {
  const env = Object.freeze({ ...input.env }), scope = parseTerminalScope(input.scope);
  const native = deviceConfig(origin.origin, env), serviceKey = input.serviceKey;
  if (!/^[a-f0-9]{64}$/.test(serviceKey) || scope.suite !== "s3rch-device-transfer" || !native ||
      native.scope.tenant !== scope.tenant || native.provider.issuer !== scope.issuer ||
      !scope.clients.includes(native.provider.clientId) ||
      native.auth !== "https://api.test.hyperme.sh/auth/sea-device-link/v1/" ||
      native.acl !== "https://api.test.hyperme.sh/api/v1/acl/sociacl/device-transfer/" ||
      native.provider.authorizationEndpoint !== scope.issuer + "/protocol/openid-connect/auth" ||
      native.provider.tokenEndpoint !== scope.issuer + "/protocol/openid-connect/token" ||
      native.provider.jwksUri !== scope.issuer + "/protocol/openid-connect/certs") throw Error("Terminal device configuration unavailable");
  const authorization = new URL(native.provider.authorizationEndpoint);
  return async (request: Request): Promise<Response> => {
    try {
      if (!matchesRequestOrigin(request, origin)) return refused();
      const action = new URL(request.url).pathname.match(/^\/api\/identity\/device\/(authorize|callback|config|logout|relay|state|current)$/)?.[1];
      if (!action || (request.method === "GET" ? !["authorize", "callback", "config"].includes(action) :
          request.method !== "POST" || !["logout", "relay", "state", "current"].includes(action)) ||
          request.method === "POST" && request.headers.get("origin") !== origin.origin) return refused();
      const authority = createTerminalHttpAuthority({ serviceKey, scopes: [scope] }, fetcher);
      return await withTerminalRun(request, authority, () => deviceServer(request, action, env, fetcher), response => {
        if (response.status === 200) return true;
        if (response.status !== 302) return false;
        const location = response.headers.get("location");
        if (action === "callback") return location === "/identity/devices" && issued(response, devicePersonCookie);
        if (action !== "authorize" || !location || !issued(response, devicePendingCookie)) return false;
        const target = new URL(location);
        return target.origin === authorization.origin && target.pathname === authorization.pathname &&
          target.searchParams.get("client_id") === native.provider.clientId &&
          target.searchParams.get("redirect_uri") === origin.origin + "/api/identity/device/callback";
      });
    } catch { return refused(); }
  };
}
