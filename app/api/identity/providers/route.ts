import { withConfiguredTerminalHandler } from "@/lib/identity/terminal-configured-route";
import { publicLoginProviders } from "@/lib/identity/providers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Sign-in options for the UI. Ids, kinds and labels only. */
async function nativeGET(_request: Request) {
  return Response.json({ providers: publicLoginProviders() }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = withConfiguredTerminalHandler(nativeGET);
