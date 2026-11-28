import { createRoomWebhookDelivery, type RoomWebhookSubscription } from "./room-webhook-delivery";
import { roomWebhookCallback } from "./room-webhook-callback";
import { createSpanopticonRecordStore } from "./spanopticon-record-store-server";
import { StatementSourceConflict } from "./acl-statement-source-server";
import { getSquadForumServer } from "./squad-forum-server";
import { createForumAuthority } from "./identity/forum-authority";
import { roomAuthorityDiagnosticsBlock } from "./room-authority-diagnostics";
import { readSeaRequestSession } from "./identity/sea-request-session";
import { authenticateAgentRequest } from "./identity/site-agent-session-server";
import { matchesBrowserOrigin, matchesRequestOrigin } from "./request-origin";
import { readBoundedIdentityJson, readBoundedIdentityText } from "./identity/bounded-json";
import { isForumObjectId, isSeaPubkey } from "./identity/forum-check";
import { projectSharedRoomWebhookEvents } from "./room-webhook-events";
import { createRoomChatAdmission, snapshotRoomChatEnvelope, type SignedRoomChat } from "./room-chat-admission";
import { nativeRoomBotGun } from "./native-room-bot-gun";
import { isRoomTaskBody } from "./room-tasks";
import { createRoomChatReceiveQueue } from "./room-chat-receive-queue";
import { encodeKey } from "./identity/check";

const collectionHistorySeconds = 3_600;
const clock = () => Math.floor(Date.now() / 1000);
type SiteAcl = NonNullable<ReturnType<typeof getSquadForumServer>>;
const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function authorityFor(site: SiteAcl, room: string, signal: AbortSignal, freezeSnapshot = false) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const at = clock();
    signal.throwIfAborted();
    let snapshot;
    try {
      snapshot = await site.source.read(at, signal);
    } catch (error) {
      if (error instanceof StatementSourceConflict) continue;
      throw error;
    }
    const authority = createForumAuthority(site.config, freezeSnapshot ? () => at : clock);
    const verified = await authority.refresh(snapshot, at);
    if (clock() !== at) continue;
    if (verified.ok && !roomAuthorityDiagnosticsBlock(verified.diagnostics, snapshot, authority.graph, room)) {
      return { at, graph: authority.graph };
    }
    break;
  }
  throw Error("Room webhook authority unavailable");
}

function runtime() {
  const secret = process.env.S3RCH_ROOM_WEBHOOK_SIGNING_KEY;
  const origin = process.env.S3RCH_ROOM_WEBHOOK_RECORD_ORIGIN;
  const tenant = process.env.S3RCH_ROOM_WEBHOOK_RECORD_TENANT_ID;
  const apiKey = process.env.S3RCH_ROOM_WEBHOOK_RECORD_API_KEY;
  if (!secret || !origin || !tenant || !apiKey) return;
  if (secret.length < 32 || tenant !== process.env.S3RCH_STATEMENT_SOURCE_TENANT_ID) throw Error("Invalid room webhook configuration");
  const site = getSquadForumServer();
  if (!site) return;
  const callback = roomWebhookCallback(site.origin);
  if (!callback) return;
  const delivery = createRoomWebhookDelivery({
    records: createSpanopticonRecordStore({ origin, tenant, apiKey }), secret,
    async canDeliver(subscription, signal, event) {
      if (!await nativeRoomBotGun(site.origin).isShared(subscription.room, subscription.owner, signal)) return false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const { at, graph } = await authorityFor(site, subscription.room, signal);
        const author = event?.type === "room.message.created" ? event.message.author : event?.object.author;
        const authoredAt = event?.type === "room.message.created" ? event.message.createdAt : event?.object.changedAt;
        const allowed = (!author || (authoredAt !== undefined && !!graph.writerKey(author, authoredAt, at) &&
          graph.checkForumSee(subscription.room, author, at).allowed &&
          graph.checkPost(subscription.room, author, at).allowed)) &&
          graph.ownerOf(subscription.room) === subscription.owner &&
          graph.checkForumSee(subscription.room, subscription.bot, at).allowed;
        if (clock() === at) return allowed;
      }
      throw new StatementSourceConflict();
    },
    async send(subscription: RoomWebhookSubscription, body, signature, signal) {
      if (subscription.url !== callback) return false;
      const response = await fetch(callback, {
        method: "POST", signal, redirect: "error", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json", "X-S3RCH-Signature": signature, "X-S3RCH-Subscription": subscription.id },
        body,
      });
      await response.body?.cancel();
      return response.ok;
    },
  });
  return { site, delivery, callback };
}

export async function roomWebhookRequest(request: Request, action: "manage" | "receive" | "inbox") {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]);
  try {
    const enabled = runtime();
    if (!enabled) return reply(503, { error: "webhooks-unavailable" });
    const { site, delivery, callback } = enabled;
    const origin = new URL(site.origin);
    if (!matchesRequestOrigin(request, origin)) return reply(403, { error: "origin" });
    if (action === "inbox") {
      const bot = await authenticateAgentRequest(request, ["room:webhook:read"]);
      const id = new URL(request.url).searchParams.get("subscription");
      if (!bot || !id) return reply(403, { error: "bot" });
      const events = await delivery.inbox(id, bot.agent, signal);
      return events ? reply(200, { events }) : reply(403, { error: "bot" });
    }
    if (!request.body || request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
      return reply(400, { error: "body" });
    }
    if (action === "receive") {
      const id = request.headers.get("x-s3rch-subscription");
      const signature = request.headers.get("x-s3rch-signature");
      if (!id || !signature) return reply(403, { error: "signature" });
      const body = await readBoundedIdentityText(new Response(request.body), 4096, signal);
      return await delivery.receive(id, body, signature, signal)
        ? reply(200, { accepted: true }) : reply(403, { error: "signature" });
    }
    if (!matchesBrowserOrigin(request, origin) || request.headers.has("authorization")) {
      return reply(403, { error: "room-owner" });
    }
    const raw = await readBoundedIdentityJson(new Response(request.body), 4096, signal);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return reply(400, { error: "body" });
    const body = raw as Record<string, unknown>;
    if (typeof body.room !== "string" || !isForumObjectId(body.room, "room")) return reply(400, { error: "room" });
    const session = await readSeaRequestSession(request);
    const { at, graph } = await authorityFor(site, body.room, signal);
    const owner = session && graph.principalForKey(session.key, at);
    if (!owner || owner !== graph.ownerOf(body.room)) return reply(403, { error: "room-owner" });
    if (body.action === "list") return reply(200, { subscriptions: await delivery.list(body.room, owner, signal) });
    if (body.action === "remove" && typeof body.id === "string") {
      return reply(await delivery.remove(body.room, owner, body.id, signal) ? 200 : 404, {});
    }
    if (body.action !== "subscribe" || typeof body.bot !== "string" || !isSeaPubkey(body.bot)) return reply(400, { error: "body" });
    if (!graph.checkForumSee(body.room, body.bot, at).allowed) return reply(403, { error: "bot-see" });
    return reply(201, await delivery.subscribe({ room: body.room, owner, bot: body.bot, url: callback }, signal));
  } catch {
    return reply(503, { error: "webhooks-unavailable" });
  }
}

type ObservedRoom = {
  rows: Map<string, SignedRoomChat>;
  refresh(next: Awaited<ReturnType<typeof authorityFor>>): void;
  stop(): void;
};
const observed = new Map<string, ObservedRoom>();
let cursor = 0;

async function collectRoomEvents(enabled: NonNullable<ReturnType<typeof runtime>>, signal: AbortSignal) {
  const { site, delivery } = enabled;
  const rooms = await delivery.rooms(signal);
  const current = new Set(rooms.map(([room]) => room));
  for (const [room, watcher] of observed) {
    if (current.has(room)) continue;
    watcher.stop();
    observed.delete(room);
  }
  if (!rooms.length) return;
  const mesh = nativeRoomBotGun(site.origin);
  const [room, owner] = rooms[cursor++ % rooms.length];
  if (!await mesh.isShared(room, owner, signal)) return;
  const snapshot = await authorityFor(site, room, signal, true);
  const { at, graph } = snapshot;
  if (graph.ownerOf(room) !== owner) return;
  let watcher = observed.get(room);
  if (!watcher) {
    const rows = new Map<string, SignedRoomChat>();
    let current = snapshot;
    const admission = createRoomChatAdmission({
      graph: {
        writerKey: (...args) => current.graph.writerKey(...args),
        principalForKey: (...args) => current.graph.principalForKey(...args),
        checkForumSee: (...args) => current.graph.checkForumSee(...args),
        checkPost: (...args) => current.graph.checkPost(...args),
      },
      readerKey: () => current.graph.writerKey(owner, current.at, current.at),
      clock: () => current.at,
    });
    const queue = createRoomChatReceiveQueue(admission, room, row => {
      rows.set(encodeKey(row.id), row);
      if (rows.size > 8192) rows.delete(rows.keys().next().value!);
    });
    // Newer candidates wait outside the admitted history until the next
    // authority snapshot covers their timestamps.
    const waiting = new Map<string, SignedRoomChat>();
    const stop = mesh.observe(room, (value, key) => {
      const row = snapshotRoomChatEnvelope(value);
      if (!row || row.room !== room || encodeKey(row.id) !== key || row.ts > clock()) return;
      if (row.ts <= current.at) {
        void queue.enqueue(row, key);
        return;
      }
      if (!waiting.has(key) && waiting.size >= 8192) waiting.delete(waiting.keys().next().value!);
      waiting.set(key, row);
    });
    watcher = {
      rows,
      refresh(next) {
        current = next;
        void queue.resume();
        for (const [key, row] of waiting) {
          if (row.ts > next.at) continue;
          waiting.delete(key);
          void queue.enqueue(row, key);
        }
      },
      stop() { waiting.clear(); queue.close(); stop(); },
    };
    observed.set(room, watcher);
    return;
  }
  watcher.refresh(snapshot);
  const admission = createRoomChatAdmission({
    graph, readerKey: () => graph.writerKey(owner, at, at), clock: () => at,
  });
  const candidates = [...watcher.rows].filter(([, row]) => row.ts >= at - collectionHistorySeconds || isRoomTaskBody(row.body));
  const admitted: SignedRoomChat[] = [];
  for (let index = 0; index < candidates.length; index += 16) {
    signal.throwIfAborted();
    const batch = await Promise.all(candidates.slice(index, index + 16)
      .map(([key, row]) => admission.receive(row, room, key)));
    for (const verified of batch) if (verified) admitted.push(verified);
  }
  const events = projectSharedRoomWebhookEvents(room, admitted, admission).filter(event => {
    const publishedAt = event.type === "room.message.created" ? event.message.createdAt : event.object.changedAt;
    return publishedAt >= at - collectionHistorySeconds;
  });
  await delivery.enqueueRoom(room, events, signal);
}

let running = false;
export function startRoomWebhookWorker() {
  if (running || !process.env.S3RCH_ROOM_WEBHOOK_SIGNING_KEY) return;
  running = true;
  function schedule(operation: (enabled: NonNullable<ReturnType<typeof runtime>>) => Promise<unknown>) {
    let active = false;
    const timer = setInterval(() => {
      if (active) return;
      active = true;
      void Promise.resolve().then(async () => {
        const enabled = runtime();
        if (enabled) await operation(enabled);
      }).catch(() => {}).finally(() => { active = false; });
    }, 2_000);
    timer.unref();
  }
  schedule(enabled => enabled.delivery.deliverNext(AbortSignal.timeout(9_000)));
  schedule(enabled => collectRoomEvents(enabled, AbortSignal.timeout(15_000)));
}
