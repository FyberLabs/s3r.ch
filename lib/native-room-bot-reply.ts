import { CHAT_BODY_MAX } from "./chat";
import { createForumAuthority, type ForumAuthorityConfig, type ForumAuthoritySnapshot } from "./identity/forum-authority";
import { readBoundedIdentityJson } from "./identity/bounded-json";
import { encodeKey } from "./identity/check";
import { isForumObjectId } from "./identity/forum-check";
import { createRoomChatAdmission, snapshotRoomChatEnvelope, type SignedRoomChat } from "./room-chat-admission";
import { roomAuthorityDiagnosticsBlock } from "./room-authority-diagnostics";

export const NATIVE_ROOM_REPLY_SCOPE = "room:post";
type BotAuthorization = { agent: string; principal: string; delegationId: string };
type RoomReplyTransport = {
  isShared(room: string, owner: string, signal: AbortSignal): Promise<boolean>;
  publish(message: SignedRoomChat, signal: AbortSignal): Promise<void>;
};

export function createNativeRoomBotReply(input: {
  authenticate(request: Request): Promise<BotAuthorization | null>;
  authority: ForumAuthorityConfig;
  parent: { id: string; owner: string };
  read(at: number, signal: AbortSignal): Promise<ForumAuthoritySnapshot>;
  transport: RoomReplyTransport;
  clock?: () => number;
}) {
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  async function authorizeRoom(row: SignedRoomChat, agent: string, signal: AbortSignal) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const at = clock();
      const snapshot = await input.read(at, signal);
      const authority = createForumAuthority(input.authority, clock);
      const verified = await authority.refresh(snapshot, at);
      if (clock() !== at) continue;
      if (!verified.ok || roomAuthorityDiagnosticsBlock(verified.diagnostics, snapshot, authority.graph, row.room) ||
        authority.graph.ownerOf(input.parent.id) !== input.parent.owner) {
        throw Error("Room authority unavailable");
      }
      const owner = authority.graph.ownerOf(row.room);
      const writer = authority.graph.writerKey(agent, row.ts, at);
      const admission = createRoomChatAdmission({ graph: authority.graph, readerKey: () => writer, parent: input.parent.id, clock });
      const admitted = await admission.receive(row, row.room, encodeKey(row.id));
      if (clock() !== at) continue;
      return owner && admitted ? { owner, admitted, at } : null;
    }
    throw Error("Room authority expired");
  }

  return async (request: Request) => {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
      ![null, "identity"].includes(request.headers.get("content-encoding")) || !request.body) {
      return reply(415, { error: "request-type" });
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]);
    let raw: unknown;
    try {
      raw = await readBoundedIdentityJson(new Response(request.body), 12_288, signal);
    } catch {
      return reply(400, { error: "invalid-reply" });
    }
    const row = snapshotRoomChatEnvelope(raw);
    if (!row || !isForumObjectId(row.room, "room") || row.actor !== "bot" || row.body.length > CHAT_BODY_MAX || /^s3rch-[\w-]+:/.test(row.body)) {
      return reply(400, { error: "invalid-reply" });
    }
    try {
      const bot = await input.authenticate(request);
      if (!bot || bot.agent !== row.author) return reply(403, { error: "bot-not-authorized" });
      const at = clock();
      if (row.ts < at - 60 || row.ts > at) return reply(400, { error: "invalid-reply-time" });
      const first = await authorizeRoom(row, bot.agent, signal);
      if (!first) return reply(403, { error: "room-post-denied" });
      if (!await input.transport.isShared(row.room, first.owner, signal)) return reply(404, { error: "shared-room-unavailable" });
      const current = await input.authenticate(request);
      if (current?.agent !== bot.agent || current.principal !== bot.principal || current.delegationId !== bot.delegationId) {
        return reply(403, { error: "bot-not-authorized" });
      }
      const final = clock() === first.at ? first : await authorizeRoom(row, current.agent, signal);
      signal.throwIfAborted();
      if (!final || final.owner !== first.owner) return reply(403, { error: "room-post-denied" });
      if (clock() !== final.at) return reply(503, { error: "room-authority-unavailable" });
      await input.transport.publish(final.admitted, signal);
      return reply(200, { id: final.admitted.id });
    } catch {
      return reply(503, { error: "room-reply-unavailable" });
    }
  };
}
