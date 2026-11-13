import { getMediaWrapService } from "@/lib/media-wrap-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const service = getMediaWrapService();
    if (service) return await service(request);
  } catch { /* Keep private configuration and provider responses server-side. */ }
  return new Response(null, { status: 503, headers: {
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } });
}
