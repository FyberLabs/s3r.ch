import { configuredTerminalRequest } from "@/lib/identity/terminal-configured-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) {
  return configuredTerminalRequest(request, async () => new Response(null, { status: 404 }));
}
