import { getSquadPilotServer, squadPilotReady } from "@/lib/squad-pilot-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const { path } = await context.params;
    if (path.length !== 1 || path[0] !== "health") return Response.json({ ready: false }, { status: 404, headers });
    const pilot = getSquadPilotServer();
    if (!pilot) return Response.json({ ready: false }, { status: 404, headers });
    const ready = await squadPilotReady(pilot, request.signal);
    return Response.json({ ready }, { status: ready ? 200 : 503, headers });
  } catch { return Response.json({ ready: false }, { status: 503, headers }); }
}
export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const reply = (status: number) => Response.json({ error: "pilot-unavailable" }, { status, headers: { "Cache-Control": "no-store" } });
  try {
    const { path } = await context.params;
    if (path[0] === "assignment" || path[0] === "session") return reply(404);
    const pilot = getSquadPilotServer();
    if (!pilot) return reply(404);
    if (path.length === 1 && path[0] === "statement") return pilot.services.statements ? pilot.services.statements(request) : reply(503);
    if (path.length === 1 && path[0] === "authority") return pilot.services.authority(request);
    return reply(404);
  } catch { return reply(503); }
}
