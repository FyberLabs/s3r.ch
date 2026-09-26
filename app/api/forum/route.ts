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
import { readForumBotToken, signForumBotToken } from "@/lib/identity/forum-token";
import { ownerForOAuth, ownerForWallet } from "@/lib/identity/link";
import { readBackupFromRequest } from "@/lib/identity/oauth";
import { readSessionToken } from "@/lib/identity/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * AI forum for bots, cloud agents, and the signed-in owner.
 *
 * Resolve first: a SIWE wallet or a linked Keycloak subject becomes the one
 * sociacl owner (the checksummed address). Invite and group checks then run
 * on that address. Owner-private unless a direct invite or group membership.
 * An unlinked OAuth session is not an owner. A forum bot token is that
 * same owner for a headless bot, not a second owner and not a Hypermesh
 * API key. Gun mesh keys stay on the signing wallet. There is no second
 * API key. The JSON body cannot name another owner.
 */
export async function GET(request: Request) {
  const session = await requireSession(request);
  if (!session.ok) return session.response;
  const handle = new URL(request.url).searchParams.get("snapshot");
  if (handle !== null) {
    const hit = getForum().readSnapshot({ owner: session.address, handle });
    if (!hit) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(hit.bytes), {
      status: 200,
      headers: {
        "content-type": hit.mime,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
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

  if (isTokenMint(body)) {
    if (session.via === "forum-bot") {
      return Response.json({ denied: true, reason: "forum-token" }, { status: 403 });
    }
    let secret: string;
    try {
      secret = identitySecretOrThrow();
    } catch (error) {
      return (
        secretFailureResponse(error) ??
        Response.json({ error: "Identity session is not configured." }, { status: 500 })
      );
    }
    const token = await signForumBotToken({ owner: session.address }, secret);
    return Response.json({ token, owner: session.address });
  }

  const result = handleForumPost(getForum(), session.address, body);
  return Response.json(result.body, { status: result.status });
}

function isTokenMint(body: unknown): boolean {
  return !!body && typeof body === "object" && (body as { action?: unknown }).action === "token";
}

async function requireSession(
  request: Request,
): Promise<
  | { ok: true; address: string; via: "wallet" | "oauth" | "forum-bot" }
  | { ok: false; response: Response }
> {
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
      return { ok: true, address: owner, via: "wallet" };
    } catch {
      return {
        ok: false,
        response: Response.json({ error: "unauthorized" }, { status: 401 }),
      };
    }
  }

  try {
    const backup = await readBackupFromRequest(request);
    const linked = backup ? ownerForOAuth(backup.sub) : null;
    if (linked) return { ok: true, address: linked, via: "oauth" };
  } catch {
    return {
      ok: false,
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    };
  }

  const header = request.headers.get("x-s3rch-forum-token");
  if (header && header.length <= 4096) {
    try {
      const bot = await readForumBotToken(header.trim(), secret);
      return { ok: true, address: bot.owner, via: "forum-bot" };
    } catch {
      return {
        ok: false,
        response: Response.json({ error: "unauthorized" }, { status: 401 }),
      };
    }
  }

  return {
    ok: false,
    response: Response.json({ error: "unauthorized" }, { status: 401 }),
  };
}
