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
import { signedRoomMessageId } from "./room-message-id";
export { signedRoomMessageId } from "./room-message-id";
async function principalPrefix(author: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(author)));
  return Array.from(bytes.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("");
}
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0);
function payload(input: unknown): ChatMessage | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  try {
    const row = Object.getOwnPropertyDescriptors(input);
    if (Object.values(row).some(p => !("value" in p))) return null;
    const v = Object.fromEntries(Object.entries(row).map(([k, p]) => [k, p.value]));
    if (!signedRoomMessageId(v.id) || typeof v.room !== "string" || !v.room || v.room.length > 512 || v.room.trim() !== v.room ||
        !isSeaPubkey(v.author) || typeof v.body !== "string" || !v.body || v.body.trim() !== v.body || v.body.length > (v.body.startsWith("s3rch-work:v1:") ? 512 : CHAT_BODY_MAX) ||
        !integer(v.ts) || v.v !== 1 || (v.actor !== undefined && v.actor !== "bot")) return null;
    return Object.freeze({ id: v.id, room: v.room, author: v.author, body: v.body, ts: v.ts, v: 1,
      ...(v.actor === "bot" ? { actor: "bot" } : {}) });
  } catch { return null; }
}

/** Shape-only immutable transport snapshot; this does not authenticate the row. */
export function snapshotRoomChatEnvelope(input: unknown): SignedRoomChat | null {
  const parsed = payload(input);
  if (!parsed) return null;
  const descriptor = Object.getOwnPropertyDescriptor(input, "sig");
  const sig = descriptor && "value" in descriptor ? descriptor.value : null;
  return typeof sig === "string" && sig.length <= 8192 ? Object.freeze({ ...parsed, v: 1 as const, sig }) : null;
}

export function createRoomChatAdmission(input: {
  graph: Pick<ForumAuthorityGraph, "writerKey" | "principalForKey" | "checkForumSee" | "checkPost">;
  /** Current session signing key, not a wallet address or a caller-supplied principal. */
  readerKey(): string | null;
  /** Protected namespace parent; its revocation always dominates room grants. */
  parent?: string;
  clock?: () => number;
}) {
  const { graph } = input, clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  // Cryptographic queue priority only, never display authority. Keep a bounded
  // cache of source-verified keys through transient authority refreshes.
  const queueKeys = new Map<string, string>();
  async function authenticateEnvelope(row: SignedRoomChat): Promise<boolean | null> {
    const current = graph.writerKey(row.author, row.ts, clock());
    if (current) {
      queueKeys.delete(row.author); queueKeys.set(row.author, current);
      if (queueKeys.size > 128) queueKeys.delete(queueKeys.keys().next().value!);
    }
    const key = current ?? queueKeys.get(row.author);
    if (!key) return null;
    try {
      if (!row.sig.startsWith("SEA") || !row.id.startsWith(`s3rch:chat:${await principalPrefix(row.author)}`)) return false;
      // Existing Gun SEA verification uses asynchronous WebCrypto. The ingress
      // queue bounds and serializes this work before protected queue allocation.
      const decoded = await readForumSignature(row.sig, key), signed = payload(decoded);
      return !!signed && !!decoded && typeof decoded === "object" &&
        (decoded as {domain?: unknown}).domain === domain && JSON.stringify(signed) === JSON.stringify(payload(row));
    } catch { return false; }
  }
  const proofs = createForumReceiveProofs({
    key: principal => graph.writerKey(principal, clock(), clock()),
    ready: () => integer(clock()), verify: readForumSignature,
  });
  function allowed(row: ChatMessage, key: string): boolean {
    const at = clock(), readerKey = input.readerKey();
    const reader = readerKey && graph.principalForKey(readerKey, at);
    return integer(at) && row.ts <= at && !!reader && graph.writerKey(row.author, row.ts, at) === key &&
      (!input.parent || (graph.checkForumSee(input.parent, reader, at).allowed &&
        graph.checkForumSee(input.parent, row.author, at).allowed && graph.checkPost(input.parent, row.author, at).allowed)) &&
      graph.checkForumSee(row.room, reader, at).allowed &&
      graph.checkForumSee(row.room, row.author, at).allowed && graph.checkPost(row.room, row.author, at).allowed;
  }
  async function receive(input: unknown, room: string, transportKey: string): Promise<SignedRoomChat | null> {
    const envelope = snapshotRoomChatEnvelope(input), parsed = payload(envelope);
    if (!envelope || !parsed || parsed.room !== room || encodeKey(parsed.id) !== transportKey) return null;
    const sig = envelope.sig;
    const at = clock(), key = graph.writerKey(parsed.author, parsed.ts, at);
    if (!key || !allowed(parsed, key) || !parsed.id.startsWith(`s3rch:chat:${await principalPrefix(parsed.author)}`)) return null;
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
    authenticateEnvelope,
    canRead(room: string): boolean {
      const at = clock(), key = input.readerKey(), reader = key && graph.principalForKey(key, at);
      return integer(at) && !!reader && (!input.parent || graph.checkForumSee(input.parent, reader, at).allowed) &&
        graph.checkForumSee(room, reader, at).allowed;
    },
    canCompose(room: string, currentPair: () => SeaPair | null): boolean {
      const pair = currentPair(), at = clock();
      const author = pair && graph.principalForKey(pair.pub, at);
      return !!pair && !!author && allowed({ id: "", room, author, body: "", ts: at, v: 1 }, pair.pub);
    },
    valid: (row: ChatMessage) => proofs.valid(row),
    readable: (rows: readonly ChatMessage[], room: string) => rows.filter(row => row.room === room && proofs.valid(row)),
    reset: () => { proofs.reset(); queueKeys.clear(); },
    async compose(room: string, body: string, currentPair: () => SeaPair | null): Promise<SignedRoomChat | null> {
      const pair = currentPair(), at = clock();
      if (!pair || !integer(at)) return null;
      const author = graph.principalForKey(pair.pub, at);
      if (!author) return null;
      const prefix = await principalPrefix(author);
      const row = payload({ id: `s3rch:chat:${prefix}${shortChatEntropy(16)}`, room, body: body.trim(), author, ts: at, v: 1 });
      if (!row || !allowed(row, pair.pub)) return null;
      const sig = await signForumRecord({ domain, ...row }, pair);
      if (!sig || currentPair() !== pair || !allowed(row, pair.pub)) return null;
      const admitted = await receive({ ...row, sig }, room, encodeKey(row.id));
      return currentPair() === pair && admitted && proofs.valid(admitted) ? admitted : null;
    },
  });
}
export type RoomChatAdmission = ReturnType<typeof createRoomChatAdmission>;
