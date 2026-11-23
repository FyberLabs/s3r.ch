import { channel } from "node:diagnostics_channel";
import { NextResponse, type NextRequest } from "next/server";
import { terminalRuntimeConfig } from "./lib/identity/terminal-runtime-config";
import { terminalRouteKind, terminalGrantPresent } from "./lib/identity/terminal-route-policy";
import { matchesRequestOrigin } from "./lib/request-origin";
import { testOriginAllowed } from "./lib/test-origin-guard";
/** Rejection only. Proxy is a separate runtime: it never grants authority to handlers. */
export function proxy(request: NextRequest) {
  if (!testOriginAllowed(process.env.S3RCH_TEST_ORIGIN_ID, request.headers.get("x-azure-fdid"), {
    method: request.method, pathname: request.nextUrl.pathname,
  })) return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });
  try {
    const { config } = terminalRuntimeConfig();
    if (!config) return NextResponse.next();
    const cookies = request.headers.get("cookie") ?? "";
    // Container liveness is read-only and must remain available on localhost.
    if (request.method === "GET" && new URL(request.url).pathname === "/api/health" && !cookies) return NextResponse.next();
    if (cookies.length > 16384) throw Error("Terminal cookie bound");
    if (!matchesRequestOrigin(request, new URL(config.origin))) throw Error("Terminal origin unavailable");
    const kind = terminalRouteKind(request), grant = terminalGrantPresent(request);
    if (kind === "unsupported" || kind === "api" && grant || ["experiment", "device", "startup"].includes(kind) && !grant) throw Error("Terminal route unavailable");
    return NextResponse.next();
  } catch (error) {
    channel("s3rch.terminal.rejection").publish({ error });
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
