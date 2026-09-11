import {
  identitySecretOrThrow,
  readSessionFromRequest,
  secretFailureResponse,
} from "@/lib/identity/http";
import { readSessionToken } from "@/lib/identity/session";
import { sessionGatedAttest } from "@/lib/oracles-attest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Session-gated hop to Panopticon `POST /api/v1/oracles/v0/attest`.
 * SIWE stays on this origin. Product API key stays on the server.
 * Empty env / hop fail → 503; keep browser-first SIWE / ENS / ERC-1271.
 * Plane `ok: false` is HTTP 200. Do not invent a grant from a miss.
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
    body = {};
  }

  const result = await sessionGatedAttest({ sessionAddress, body });
  return Response.json(result.body, { status: result.status });
}
