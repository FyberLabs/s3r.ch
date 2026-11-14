import "@/lib/faker-v7-compat";
import { createOutboundAdapters } from "@/lib/outbound-adapters";
import {
  adapterForNetwork,
  canOutboundPost,
  draftFromItem,
  outboundStatus,
  parseOutboundRequest,
} from "@/lib/outbound";
import { readSeaRequestSession } from "@/lib/identity/sea-request-session";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Explicit Farcaster / ATProto outbound. SIWE required.
 * Does not write Gun. Share-into-mesh does not call this.
 * Credentials stay in server env — never NEXT_PUBLIC, never on Gun.
 */
export async function GET(request: Request) {
  const session = await requireSession(request);
  if (!session.ok) return session.response;
  const adapters = createOutboundAdapters();
  return Response.json({ adapters: outboundStatus(adapters) });
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

  const parsed = parseOutboundRequest(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  if (!canOutboundPost(parsed.item, session.owner)) {
    return Response.json({ error: "You can only post your own note." }, { status: 403 });
  }

  const adapters = createOutboundAdapters();
  const adapter = adapterForNetwork(adapters, parsed.network);
  if (!adapter) {
    return Response.json({ error: "Unknown network." }, { status: 400 });
  }

  const result = await adapter.post(draftFromItem(parsed.item));
  return Response.json(result, { status: result.ok ? 200 : 502 });
}

async function requireSession(request: Request): Promise<
  | { ok: true; owner: string }
  | { ok: false; response: Response }
> {
  const session = await readSeaRequestSession(request);
  return session ? { ok: true, owner: session.key } : {
    ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }),
  };
}
