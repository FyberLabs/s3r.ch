import { withConfiguredTerminalHandler } from "@/lib/identity/terminal-configured-route";
import { getSiteAclServer } from "@/lib/site-acl-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function nativePOST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const reply = (status: number) => Response.json({ error: "site-acl-unavailable" }, { status, headers: { "Cache-Control": "no-store" } });
  try {
    const { path } = await context.params;
    const site = getSiteAclServer();
    if (!site) return reply(503);
    if (path.length === 1 && path[0] === "statement") return site.services.statements(request);
    if (path.length === 1 && path[0] === "room") return site.services.rooms(request);
    if (path.length === 1 && path[0] === "meeting") return site.services.meeting?.(request) ?? reply(404);
    if (path.length === 1 && path[0] === "authority") return site.services.authority(request);
    return reply(404);
  } catch { return reply(503); }
}

export const POST = withConfiguredTerminalHandler(nativePOST);