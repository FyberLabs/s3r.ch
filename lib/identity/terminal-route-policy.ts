/** Shared route inventory: proxy rejects unsupported requests; route handlers admit. */
export function terminalRouteKind(request: Request) {
  const path = new URL(request.url).pathname;
  if (path === "/api/internal/nightly-run") return "control";
  if (path === "/api/experiments" || path.startsWith("/api/experiments/")) return "experiment";
  if (path.startsWith("/api/identity/device/")) return "device";
  if (path.startsWith("/api/identity/startup/") || path === "/api/identity/oauth/callback") return "startup";
  if (/^\/api\/identity\/sea\/(session|challenge|exchange|logout)$/.test(path) || /^\/api\/squad\/pilot\/session\/(challenge|exchange|logout)$/.test(path)) return "sea";
  if (request.method === "GET" && ["/api/identity/session", "/api/identity/oauth/session", "/api/identity/providers"].includes(path) || request.method === "POST" && path === "/api/identity/logout") return "auxiliary";
  if (path.startsWith("/api/identity/")) return "unsupported";
  return path.startsWith("/api/") ? "api" : "page";
}
export function terminalGrantPresent(request: Request) {
  return (request.headers.get("cookie") ?? "").split(";").some(cookie => cookie.trim().startsWith("__Host-nightly-run-grant="));
}
