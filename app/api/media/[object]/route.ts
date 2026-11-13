import { getMediaObjectService } from "@/lib/media-store-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(request: Request, context: { params: Promise<{ object: string }> }) {
  try {
    const { object } = await context.params, service = getMediaObjectService();
    if (service) return await service(request, object);
  } catch { /* Do not expose provider configuration or credentials. */ }
  return new Response(null, { status: 503, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
export const GET = handle;
export const PUT = handle;
export const POST = handle;
export const DELETE = handle;
