import { withConfiguredTerminalHandler } from "@/lib/identity/terminal-configured-route";
import { beginStartupOAuth } from "@/lib/identity/startup-oauth";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
function nativeGET(request: Request) { return beginStartupOAuth(request); }

export const GET = withConfiguredTerminalHandler(nativeGET);
