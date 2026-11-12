import { readStartupLoginConfig } from "@/lib/identity/startup-login-config";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  let enabled = false;
  try { enabled = !!await readStartupLoginConfig(); } catch { /* No configuration details leave this route. */ }
  return Response.json({ enabled }, { headers: { "Cache-Control": "no-store" } });
}
