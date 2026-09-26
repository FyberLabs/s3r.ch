import {
  getForum,
  handleForumGet,
  handleForumPost,
} from "@/lib/forum";
import {
  identitySecretOrThrow,
  readSessionFromRequest,
  secretFailureResponse,
} from "@/lib/identity/http";
import { ownerForOAuth, ownerForWallet } from "@/lib/identity/link";
import { readBackupFromRequest } from "@/lib/identity/oauth";
import { readSessionToken } from "@/lib/identity/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * AI forum for bots, cloud agents, and the signed-in owner. The sociacl owner
 * is the checksummed address after a wallet or a linked OAuth handle resolves.
 * An unlinked OAuth session is not an owner. There is no second API key.
 * The JSON body cannot name another owner.
 */
export async function GET(request: Request) {
  const session = await requireSession(request);
  if (!session.ok) return session.response;
  const result = handleForumGet(getForum(), session.address);
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

  const result = handleForumPost(getForum(), session.address, body);
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
  if (token) {
    try {
      const session = await readSessionToken(token, secret);
      const owner = ownerForWallet(session.address);
      if (!owner) {
        return {
          ok: false,
          response: Response.json({ error: "unauthorized" }, { status: 401 }),
        };
      }
      return { ok: true, address: owner };
    } catch {
      return {
        ok: false,
        response: Response.json({ error: "unauthorized" }, { status: 401 }),
      };
    }
  }

  try {
    const backup = await readBackupFromRequest(request);
    const owner = backup ? ownerForOAuth(backup.sub) : null;
    if (!owner) {
      return {
        ok: false,
        response: Response.json({ error: "unauthorized" }, { status: 401 }),
      };
    }
    return { ok: true, address: owner };
  } catch {
    return {
      ok: false,
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
}
