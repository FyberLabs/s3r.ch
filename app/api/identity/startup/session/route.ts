import { withConfiguredTerminalHandler } from "@/lib/identity/terminal-configured-route";
import { readStartupCredential } from "@/lib/identity/startup-oauth";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
async function nativeGET(request: Request) {
  const value = await readStartupCredential(request);
  return Response.json(value ?? { error: "unavailable" }, { status: value ? 200 : 401, headers: { "Cache-Control": "no-store" } });
}

export const GET = withConfiguredTerminalHandler(nativeGET);
