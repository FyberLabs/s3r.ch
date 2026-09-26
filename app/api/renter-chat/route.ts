import {
  getRenterChatNetwork,
  handleRenterChatGet,
  handleRenterChatPost,
} from "@/lib/renter-chat";
import {
  identitySecretOrThrow,
  readSessionFromRequest,
  secretFailureResponse,
} from "@/lib/identity/http";
import { readSessionToken } from "@/lib/identity/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Renter chat for bots and cloud agents. The SIWE session address is the
 * renter. There is no second API key. The JSON body cannot name another renter.
 */
export async function GET(request: Request) {
  const session = await requireSession(request);
  if (!session.ok) return session.response;
  const result = handleRenterChatGet(getRenterChatNetwork(), session.address);
  return Response.json(result.body, { status: result.status });
}

export async function POST(request: Request) {
  const session = await requireSession(request);
  if (!session.ok) return session.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON." }, { status: 400 });
  }

  const result = handleRenterChatPost(getRenterChatNetwork(), session.address, body);
  return Response.json(result.body, { status: result.status });
}

async function requireSession(
  request: Request,
): Promise<{ ok: true; address: string } | { ok: false; response: Response }> {
  let secret: string;
  try {
    secret = identitySecretOrThrow();
  } catch (error) {
    return {
      ok: false,
      response:
        secretFailureResponse(error) ??
        Response.json({ error: "Identity session is not configured." }, { status: 500 }),
    };
  }

  const token = await readSessionFromRequest(request);
  if (!token) {
    return {
      ok: false,
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    };
  }

  try {
    const session = await readSessionToken(token, secret);
    return { ok: true, address: session.address };
  } catch {
    return {
      ok: false,
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
}
