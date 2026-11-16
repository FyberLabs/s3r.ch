import { NextResponse, type NextRequest } from "next/server";
import { terminalRuntimeConfig } from "./lib/identity/terminal-runtime-config";
import { terminalRouteKind, terminalGrantPresent } from "./lib/identity/terminal-route-policy";
import { matchesRequestOrigin } from "./lib/request-origin";
/** Rejection only. Proxy is a separate runtime: it never grants authority to handlers. */
export function proxy(request: NextRequest) {
  try {
    const { config } = terminalRuntimeConfig();
    if (!config) return NextResponse.next();
    const cookies = request.headers.get("cookie") ?? "";
    // Container liveness is read-only and must remain available on localhost.
    if (request.method === "GET" && new URL(request.url).pathname === "/api/health" && !cookies) return NextResponse.next();
    if (cookies.length > 16384 || !matchesRequestOrigin(request, new URL(config.origin))) throw Error();
    const kind = terminalRouteKind(request), grant = terminalGrantPresent(request);
    if (kind === "unsupported" || kind === "api" && grant || ["experiment", "device", "startup"].includes(kind) && !grant) throw Error();
    return NextResponse.next();
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
