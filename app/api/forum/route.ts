import {
  getForum,
  handleForumGet,
  handleForumPost,
} from "@/lib/forum";
import {
  identitySecretOrThrow,
  identityUnavailableResponse,
  readSessionFromRequest,
  secretFailureResponse,
} from "@/lib/identity/http";
import { ownerForOAuthResult, ownerForWallet } from "@/lib/identity/link";
import { readBackupFromRequest } from "@/lib/identity/oauth";
import { readSessionToken } from "@/lib/identity/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Legacy human forum. Its wallet-era ledger cannot authorize a delegated SEA
 * agent. Agent credentials must never be projected onto the owner's access. */
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
    return Response.json({ error: "owner-bot-token-retired" }, {
      status: 410, headers: { "Cache-Control": "private, no-store" },
    });
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
  | { ok: true; address: string; via: "wallet" | "oauth" }
  | { ok: false; response: Response }
> {
  // Reject credential mixing rather than falling back to a human cookie.
  if (request.headers.has("x-s3rch-forum-token") || request.headers.has("authorization")) {
    return { ok: false, response: Response.json({ error: "agent-forum-unavailable" }, {
      status: 401, headers: { "Cache-Control": "private, no-store" },
    }) };
  }
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
          response: identityUnavailableResponse(),
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

  let linkStoreUnavailable = false;
  try {
    const backup = await readBackupFromRequest(request);
    const linked = backup ? ownerForOAuthResult(backup.sub) : null;
    linkStoreUnavailable = !!linked && typeof linked !== "string";
    if (typeof linked === "string") return { ok: true, address: linked, via: "oauth" };
  } catch {
    return {
      ok: false,
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    };
  }

  return {
    ok: false,
    response: linkStoreUnavailable ? identityUnavailableResponse() : Response.json({ error: "unauthorized" }, { status: 401 }),
  };
}
