import { createIndicatorClients, resolveSessionIndicators } from "@/lib/identity/indicators";
import {
  identitySecretOrThrow,
  readSessionFromRequest,
  secretFailureResponse,
} from "@/lib/identity/http";
import { readSessionToken } from "@/lib/identity/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const clients = createIndicatorClients();

/**
 * GET /api/identity/indicators?address=
 *
 * Session required. Resolves Farcaster / Lens / RSS3 held claims for the
 * **session** address only (query address must match when present).
 * Does not write to Gun. A GI miss does not drop the other claims.
 */
export async function GET(request: Request) {
  let secret: string;
  try {
    secret = identitySecretOrThrow();
  } catch (error) {
    return (
      secretFailureResponse(error) ??
      Response.json({ error: "Identity session is not configured." }, { status: 500 })
    );
  }

  const token = await readSessionFromRequest(request);
  if (!token) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let sessionAddress: string;
  try {
    sessionAddress = (await readSessionToken(token, secret)).address;
  } catch {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const queryAddress = new URL(request.url).searchParams.get("address");
  const result = await resolveSessionIndicators({
    sessionAddress,
    queryAddress,
    clients,
  });
  return Response.json(result.body, { status: result.status });
}
