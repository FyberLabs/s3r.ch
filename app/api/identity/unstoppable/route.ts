import {
  createUnstoppableLookupClient,
  resolveSessionUnstoppableClaim,
} from "@/lib/identity/unstoppable";
import {
  identitySecretOrThrow,
  readSessionFromRequest,
  secretFailureResponse,
} from "@/lib/identity/http";
import { readSessionToken } from "@/lib/identity/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const unstoppableClient = createUnstoppableLookupClient();

/**
 * GET /api/identity/unstoppable?address=
 *
 * Session required. Resolves a Polygon UNS Unstoppable held claim for the
 * **session** address only (query address must match when present).
 * Does not write to Gun. Optional `UNSTOPPABLE_API_KEY` stays server-side.
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
  const result = await resolveSessionUnstoppableClaim({
    sessionAddress,
    queryAddress,
    client: unstoppableClient,
  });
  return Response.json(result.body, { status: result.status });
}
