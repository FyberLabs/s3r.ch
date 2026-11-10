export function requestIsSecure(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() === "https";
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function requestHost(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-host");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "";
  return request.headers.get("host") ?? new URL(request.url).host;
}

/** Browser writes require an explicit canonical Origin. At a TLS terminator,
 * the public Host must also agree; a forwarded host alone cannot authorize a write. */
export function matchesBrowserOrigin(request: Request, origin: URL): boolean {
  if (request.headers.get("origin") !== origin.origin || requestHost(request) !== origin.host) return false;
  const host = request.headers.get("host");
  if (host !== null && host !== origin.host) return false;
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto !== null && forwardedProto !== origin.protocol.slice(0, -1)) return false;
  if (new URL(request.url).origin === origin.origin) return true;
  return origin.protocol === "https:" && host === origin.host && forwardedProto !== null && requestIsSecure(request);
}
