import { siteAgentSession } from "@/lib/identity/site-agent-session-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = {params: Promise<{action: string}>};
export async function POST(request: Request, context: Context) {
  return siteAgentSession(request,(await context.params).action);
}
