import {
  identitySecretOrThrow,
  readSessionFromRequest,
  secretFailureResponse,
} from "@/lib/identity/http";
import { readSessionToken } from "@/lib/identity/session";
import { sessionGatedReceipt } from "@/lib/payments-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Session-gated hop to Panopticon `POST /api/v1/payments/v0/receipt`.
 * SIWE stays on this origin. Product API key stays on the server.
 * Empty env / hop fail → 503; plane 200 (ok true or false) is passed through.
 * Do not invent a SociACL grant. Do not hard-paywall.
 */
export async function POST(request: Request): Promise<Response> {
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

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid-body" }, { status: 400 });
  }

  const result = await sessionGatedReceipt({ sessionAddress, body });
  return Response.json(result.body, { status: result.status });
}
