import { siteSeaSession } from "@/lib/identity/site-sea-session-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ action: string }> };
export async function GET(request: Request, context: Context) {
  return siteSeaSession(request, (await context.params).action);
}
export async function POST(request: Request, context: Context) {
  return siteSeaSession(request, (await context.params).action);
}
