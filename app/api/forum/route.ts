import {
  getForum,
  handleForumGet,
  handleForumPost,
} from "@/lib/forum";
import { readSeaRequestSession } from "@/lib/identity/sea-request-session";
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

async function requireSession(request: Request): Promise<
  | { ok: true; address: string }
  | { ok: false; response: Response }
> {
  // Delegated agents must use their scoped native route; never borrow owner access.
  if (request.headers.has("x-s3rch-forum-token") || request.headers.has("authorization")) {
    return { ok: false, response: Response.json({ error: "agent-forum-unavailable" }, {
      status: 401, headers: { "Cache-Control": "private, no-store" },
    }) };
  }
  const session = await readSeaRequestSession(request);
  return session ? { ok: true, address: session.key } : {
    ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }),
  };
}
