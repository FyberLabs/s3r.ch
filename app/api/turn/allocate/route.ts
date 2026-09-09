import {
  identitySecretOrThrow,
  readSessionFromRequest,
  secretFailureResponse,
} from "@/lib/identity/http";
import { readSessionToken } from "@/lib/identity/session";
import { sessionGatedAllocate } from "@/lib/turn-allocate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Session-gated hop to Panopticon `POST /api/v1/turn/allocate`.
 * SIWE stays on this origin. Product API key stays on the server.
 * Empty env / hop fail → 503; browser keeps STUN + `/gun`.
 */
async function allocate(request: Request): Promise<Response> {
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

  const result = await sessionGatedAllocate({ sessionAddress });
  return Response.json(result.body, { status: result.status });
}

export async function GET(request: Request) {
  return allocate(request);
}

export async function POST(request: Request) {
  return allocate(request);
}
