import { getMediaOwnerService } from "@/lib/media-wrap-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  try {
    const { action } = await context.params;
    const service = getMediaOwnerService();
    if (service) return await service(action, request);
  } catch { /* Private configuration and upstream details stay on the server. */ }
  return new Response(null, { status: 503, headers: {
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } });
}
