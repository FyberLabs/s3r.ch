import { withConfiguredTerminalHandler } from "@/lib/identity/terminal-configured-route";
import { siteSeaSession } from "@/lib/identity/site-sea-session-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ action: string }> };
async function nativeGET(request: Request, context: Context) {
  return siteSeaSession(request, (await context.params).action);
}
async function nativePOST(request: Request, context: Context) {
  return siteSeaSession(request, (await context.params).action);
}

export const GET = withConfiguredTerminalHandler(nativeGET);
export const POST = withConfiguredTerminalHandler(nativePOST);
