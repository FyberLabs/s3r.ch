/** Signed room-chat boundary. The authority graph must come from the owning
 * authenticated source; legacy local ACL rows cannot establish room authority. */
import { CHAT_BODY_MAX, shortChatEntropy, type ChatMessage } from "./chat";
import { createForumReceiveProofs } from "./forum-receive-proofs";
import { readForumSignature, signForumRecord } from "./forum-sign";
import { encodeKey } from "./identity/check";
import { isSeaPubkey } from "./identity/forum-check";
import type { ForumAuthorityGraph } from "./identity/forum-authority";
import type { SeaPair } from "./identity/sea";

export type SignedRoomChat = Readonly<ChatMessage & { v: 1; sig: string }>;
const domain = "s3rch-room-chat/v1";
export const signedRoomMessageId = (id: unknown): id is string =>
  typeof id === "string" && /^s3rch:chat:[0-9a-f]{32}$/.test(id);
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0);
function payload(input: unknown): ChatMessage | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  try {
    const row = Object.getOwnPropertyDescriptors(input);
    if (Object.values(row).some(p => !("value" in p))) return null;
    const v = Object.fromEntries(Object.entries(row).map(([k, p]) => [k, p.value]));
    if (!signedRoomMessageId(v.id) || typeof v.room !== "string" || !v.room || v.room.length > 512 || v.room.trim() !== v.room ||
        !isSeaPubkey(v.author) || typeof v.body !== "string" || !v.body || v.body.trim() !== v.body || v.body.length > CHAT_BODY_MAX ||
        !integer(v.ts) || v.v !== 1) return null;
    return Object.freeze({ id: v.id, room: v.room, author: v.author, body: v.body, ts: v.ts, v: 1 });
  } catch { return null; }
}

export function createRoomChatAdmission(input: {
  graph: ForumAuthorityGraph;
  /** Current session signing key, not a wallet address or a caller-supplied principal. */
  readerKey(): string | null;
  clock?: () => number;
}) {
  const { graph } = input, clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const proofs = createForumReceiveProofs({
    key: principal => graph.writerKey(principal, clock(), clock()),
    ready: () => integer(clock()), verify: readForumSignature,
  });
  function allowed(row: ChatMessage, key: string): boolean {
    const at = clock(), readerKey = input.readerKey();
    const reader = readerKey && graph.principalForKey(readerKey, at);
    return integer(at) && row.ts <= at && !!reader && graph.writerKey(row.author, row.ts, at) === key &&
      graph.checkForumSee(row.room, reader, at).allowed &&
      graph.checkForumSee(row.room, row.author, at).allowed && graph.checkPost(row.room, row.author, at).allowed;
  }
  async function receive(input: unknown, room: string, transportKey: string): Promise<SignedRoomChat | null> {
    const parsed = payload(input);
    if (!parsed || parsed.room !== room || encodeKey(parsed.id) !== transportKey) return null;
    const descriptor = Object.getOwnPropertyDescriptor(input, "sig");
    const sig = descriptor && "value" in descriptor ? descriptor.value : null;
    if (typeof sig !== "string" || sig.length > 8192) return null;
    const at = clock(), key = graph.writerKey(parsed.author, parsed.ts, at);
    if (!key || !allowed(parsed, key)) return null;
    const proof = proofs.begin();
    const decoded = await proof.read(sig, parsed.author);
    const signed = payload(decoded);
    if (!signed || !decoded || typeof decoded !== "object" || (decoded as { domain?: unknown }).domain !== domain ||
        JSON.stringify(signed) !== JSON.stringify(parsed)) return null;
    const row = Object.freeze({ ...signed, v: 1 as const, sig });
    return proof.retain(row, () => allowed(row, key)) && proofs.valid(row) ? row : null;
  }
  return Object.freeze({
    receive,
    valid: (row: ChatMessage) => proofs.valid(row),
    readable: (rows: readonly ChatMessage[], room: string) => rows.filter(row => row.room === room && proofs.valid(row)),
    reset: () => proofs.reset(),
    async compose(room: string, body: string, currentPair: () => SeaPair | null): Promise<SignedRoomChat | null> {
      const pair = currentPair(), at = clock();
      if (!pair || !integer(at)) return null;
      const author = graph.principalForKey(pair.pub, at);
      const row = payload({ id: `s3rch:chat:${shortChatEntropy(16)}`, room, body: body.trim(), author, ts: at, v: 1 });
      if (!row || !allowed(row, pair.pub)) return null;
      const sig = await signForumRecord({ domain, ...row }, pair);
      if (!sig || currentPair() !== pair || !allowed(row, pair.pub)) return null;
      return receive({ ...row, sig }, room, encodeKey(row.id));
    },
  });
}
export type RoomChatAdmission = ReturnType<typeof createRoomChatAdmission>;
