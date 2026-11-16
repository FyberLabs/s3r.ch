import { withConfiguredTerminalHandler } from "@/lib/identity/terminal-configured-route";
import { hasStartupPending, finishStartupOAuth } from "@/lib/identity/startup-oauth";
import { finishOAuth } from "@/lib/identity/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function nativeGET(request: Request) {
  return hasStartupPending(request) ? finishStartupOAuth(request) : finishOAuth(request);
}

export const GET = withConfiguredTerminalHandler(nativeGET);
