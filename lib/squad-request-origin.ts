// The standalone Next server can construct request.url from its internal
// listener. At the TLS terminator the public Host and browser Origin must
// still both match the configured deployment.
export function matchesSquadOrigin(request: Request, origin: URL): boolean {
  if (request.headers.get("origin") !== origin.origin) return false;
  const host = request.headers.get("host");
  if (host !== null && host !== origin.host) return false;
  if (new URL(request.url).origin === origin.origin) return true;
  return origin.protocol === "https:" && host === origin.host && request.headers.get("x-forwarded-proto") === "https";
}
