import { publicLoginProviders } from "@/lib/identity/providers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Sign-in options for the UI. Ids, kinds and labels only. */
export async function GET() {
  return Response.json({ providers: publicLoginProviders() }, { headers: { "Cache-Control": "no-store" } });
}
