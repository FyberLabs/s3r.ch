import { withConfiguredTerminalHandler } from "@/lib/identity/terminal-configured-route";
import { clearIdentityCookies } from "@/lib/identity/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function nativePOST(_request: Request) {
  await clearIdentityCookies();
  return Response.json({ ok: true });
}

export const POST = withConfiguredTerminalHandler(nativePOST);
