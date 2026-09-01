import { clearIdentityCookies } from "@/lib/identity/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  await clearIdentityCookies();
  return Response.json({ ok: true });
}
