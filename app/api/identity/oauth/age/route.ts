import { acceptOAuthAge } from "@/lib/identity/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return acceptOAuthAge(request);
}
