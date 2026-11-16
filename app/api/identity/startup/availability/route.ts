import { withConfiguredTerminalHandler } from "@/lib/identity/terminal-configured-route";
import { readStartupLoginConfig } from "@/lib/identity/startup-login-config";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
async function nativeGET(_request: Request) {
  let enabled = false;
  try { enabled = !!await readStartupLoginConfig(); } catch { /* No configuration details leave this route. */ }
  return Response.json({ enabled }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = withConfiguredTerminalHandler(nativeGET);
