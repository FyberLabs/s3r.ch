import { withConfiguredTerminalHandler } from "@/lib/identity/terminal-configured-route";
import { getSquadForumServer } from "@/lib/squad-forum-server";
import { createSquadForumHandler } from "@/lib/squad-forum-create";
import { readSeaRequestSession } from "@/lib/identity/sea-request-session";
import { squadForumClientConfig } from "@/lib/squad-forum-client-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (status: number) => Response.json({ error: "squad-forum-unavailable" }, { status, headers: { "Cache-Control": "no-store" } });

async function nativeGET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await context.params;
    if (path.length === 1 && path[0] === "client-config") {
      const session = await readSeaRequestSession(request);
      if (!session) return deny(401);
      const server = getSquadForumServer();
      if (!server) return deny(503);
      return Response.json({ config: squadForumClientConfig(server.origin) }, { status: 200, headers: { "Cache-Control": "no-store" } });
    }
    return deny(404);
  } catch {
    return deny(503);
  }
}

async function nativePOST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await context.params;
    const server = getSquadForumServer();
    if (!server) return deny(503);
    if (path.length === 1 && path[0] === "create") {
      return createSquadForumHandler(server.services.authenticate, server.statements)(request);
    }
    if (path.length === 1 && path[0] === "statement") return server.services.statements(request);
    if (path.length === 1 && path[0] === "room") return server.services.rooms(request);
    if (path.length === 1 && path[0] === "meeting") return server.services.meeting?.(request) ?? deny(404);
    if (path.length === 1 && path[0] === "authority") return server.services.authority(request);
    return deny(404);
  } catch {
    return deny(503);
  }
}

export const GET = withConfiguredTerminalHandler(nativeGET);
export const POST = withConfiguredTerminalHandler(nativePOST);