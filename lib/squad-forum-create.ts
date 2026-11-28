import { p256 } from "@noble/curves/nist.js";
import { parseForumAuthority, type AuthorityKind } from "./identity/forum-authority-records";
import { verifyForumKeySignature } from "./identity/forum-key-signature";
import { isForumObjectId, sameEmbeddedPrincipal } from "./identity/forum-check";
import { mintSquadForumId } from "./squad-forum-mint";
import type { LiveSquadSpec } from "./squad-view";
import { squadView } from "./squad-view";
import type { BotStatementSource } from "./forum-bot-statement-admission";
import { createForumAuthority } from "./identity/forum-authority";
import { SEA_OWNED_FORUM_AUTHORITY } from "./sea-owned-forum-policy";
import { roomAuthorityDiagnosticsBlock } from "./room-authority-diagnostics";

const labelPattern = /^[^\x00-\x1f\x7f]{1,80}$/;

export type SquadCreateErrorCode = "exists" | "bootstrap" | "unavailable" | "invalid" | "not-enrolled" | "conflict";

export class SquadCreateError extends Error {
  readonly code: SquadCreateErrorCode;
  constructor(code: SquadCreateErrorCode) {
    super(code);
    this.name = "SquadCreateError";
    this.code = code;
  }
}

export type SquadCreateRequest = Readonly<{
  version: 1;
  label: string;
  forumId?: string;
  rows: readonly Readonly<{ kind: AuthorityKind; soul: string; record: unknown }>[];
}>;

export function parseSquadCreateRequest(body: unknown): SquadCreateRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const row = body as Record<string, unknown>;
  if (row.version !== 1 || typeof row.label !== "string" || !labelPattern.test(row.label)) return null;
  if (row.forumId !== undefined && typeof row.forumId !== "string") return null;
  if (!Array.isArray(row.rows) || row.rows.length < 1 || row.rows.length > 8) return null;
  for (const envelope of row.rows) {
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
    const keys = Object.keys(envelope).sort((left, right) => left.localeCompare(right, "en")).join();
    if (keys !== "kind,record,soul") return null;
  }
  return row as SquadCreateRequest;
}

/** Verify bootstrap rows: one object on forumId owned by session key, owner see/post on forum. */
export function verifySquadBootstrapRows(
  owner: string,
  forumId: string,
  rows: SquadCreateRequest["rows"],
  at: number,
): boolean {
  if (!sameEmbeddedPrincipal(owner, forumId)) return false;
  let objectOk = false, seeOk = false, postOk = false;
  for (const envelope of rows) {
    const parsed = parseForumAuthority(envelope.kind, envelope.record);
    if (!parsed || parsed.soul !== envelope.soul) return false;
    if (parsed.row.issuedAt > at) return false;
    if (!verifyForumKeySignature(owner, parsed.row.sig, parsed.bytes)) return false;
    switch (parsed.kind) {
      case "object": {
        const record = parsed.row;
        if (record.owner !== owner || record.object !== forumId) return false;
        objectOk = true;
        break;
      }
      case "see": {
        const record = parsed.row;
        if (record.owner !== owner || record.object !== forumId || record.accessor !== owner || record.stated !== 1) return false;
        seeOk = true;
        break;
      }
      case "post": {
        const record = parsed.row;
        if (record.owner !== owner || record.object !== forumId || record.accessor !== owner || record.stated !== 1) return false;
        postOk = true;
        break;
      }
      default:
        return false;
    }
  }
  return objectOk && seeOk && postOk;
}

export async function createSquadForum(input: {
  owner: string;
  body: SquadCreateRequest;
  source: BotStatementSource;
  clock?: () => number;
}): Promise<LiveSquadSpec> {
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const at = clock();
  const forumId = input.body.forumId ?? mintSquadForumId(input.owner);
  if (!isForumObjectId(forumId, "forum")) throw new SquadCreateError("invalid");
  if (!verifySquadBootstrapRows(input.owner, forumId, input.body.rows, at)) throw new SquadCreateError("bootstrap");
  const spec = squadView({ forumId, owner: input.owner, label: input.body.label.trim() });
  const held = await input.source.read(at, AbortSignal.timeout(5000));
  const snapshot = structuredClone(held.snapshot);
  const authority = createForumAuthority(SEA_OWNED_FORUM_AUTHORITY, clock);
  const current = await authority.refresh(snapshot, at);
  if (!current.ok) throw new SquadCreateError("unavailable");
  const enrolled = new Set((snapshot.history?.accounts ?? []).map(a => a.principal));
  if (!enrolled.has(input.owner)) throw new SquadCreateError("not-enrolled");
  if (authority.graph.ownerOf(forumId) === input.owner) throw new SquadCreateError("exists");
  const additions = input.body.rows.map(row => ({ ...row }));
  const next = { ...snapshot, rows: [...snapshot.rows, ...additions] };
  const verified = await authority.refresh(next, at);
  if (!verified.ok || roomAuthorityDiagnosticsBlock(verified.diagnostics, next, authority.graph)) throw new SquadCreateError("bootstrap");
  if (authority.graph.ownerOf(forumId) !== input.owner) throw new SquadCreateError("bootstrap");
  const guard = () => { if (clock() !== at) throw new SquadCreateError("unavailable"); };
  const committed = await input.source.append(held.fence, additions, guard, AbortSignal.timeout(5000));
  if (!committed) throw new SquadCreateError("conflict");
  return { forumId: spec.forumId, owner: spec.owner, label: spec.label };
}

export function createSquadForumHandler(
  authenticate: (request: Request) => Promise<{ key: string } | null>,
  source: BotStatementSource,
  clock = () => Math.floor(Date.now() / 1000),
) {
  const reply = (status: number, body?: unknown) =>
    Response.json(body ?? { error: "unavailable" }, { status, headers: { "Cache-Control": "no-store" } });
  const statusFor: Record<SquadCreateErrorCode, number> = {
    exists: 409,
    bootstrap: 403,
    invalid: 400,
    "not-enrolled": 403,
    conflict: 409,
    unavailable: 503,
  };
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== "POST") return reply(405, { error: "method" });
      const session = await authenticate(request);
      if (!session) return reply(401, { error: "authentication" });
      const body = parseSquadCreateRequest(await request.json().catch(() => null));
      if (!body) return reply(400, { error: "request" });
      const at = clock();
      const spec = await createSquadForum({ owner: session.key, body, source, clock: () => at });
      return Response.json({ squad: spec }, { status: 201, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof SquadCreateError) {
        return reply(statusFor[error.code], { error: error.code });
      }
      return reply(503, { error: "unavailable" });
    }
  };
}