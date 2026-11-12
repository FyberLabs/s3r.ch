import { hasStartupPending, finishStartupOAuth } from "@/lib/identity/startup-oauth";
import { finishOAuth } from "@/lib/identity/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return hasStartupPending(request) ? finishStartupOAuth(request) : finishOAuth(request);
}
