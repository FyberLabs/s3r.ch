import { beginStartupOAuth } from "@/lib/identity/startup-oauth";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function GET(request: Request) { return beginStartupOAuth(request); }
