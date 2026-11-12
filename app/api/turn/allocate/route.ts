import { readSeaRequestSession } from "@/lib/identity/sea-request-session";
import { sessionGatedAllocate } from "@/lib/turn-allocate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Existing SEA proof session gates the server-only product credential hop.
 * Wallet and OIDC credentials alone grant no principal. Unavailable TURN leaves STUN. */
async function allocate(request: Request): Promise<Response> {
  const session = await readSeaRequestSession(request);
  const result = await sessionGatedAllocate({ sessionPrincipal: session?.key ?? null });
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
}
export async function GET(request: Request) { return allocate(request); }
export async function POST(request: Request) { return allocate(request); }
