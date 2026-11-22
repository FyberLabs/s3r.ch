import { createRoomWebhookDelivery, type RoomWebhookSubscription } from "./room-webhook-delivery";
import { roomWebhookCallback } from "./room-webhook-callback";
import { createSpanopticonRecordStore } from "./spanopticon-record-store-server";
import { getSquadPilotServer } from "./squad-pilot-server";
import { createForumAuthority } from "./identity/forum-authority";
import { roomAuthorityDiagnosticsBlock } from "./room-authority-diagnostics";
import { readSeaRequestSession } from "./identity/sea-request-session";
import { authenticateAgentRequest } from "./identity/site-agent-session-server";
import { matchesBrowserOrigin, matchesRequestOrigin } from "./request-origin";
import { readBoundedIdentityJson, readBoundedIdentityText } from "./identity/bounded-json";
import { isForumObjectId, isSeaPubkey } from "./identity/forum-check";
import { projectSharedRoomWebhookEvents, type RoomWebhookEvent } from "./room-webhook-events";
import { createRoomChatAdmission, snapshotRoomChatEnvelope, type SignedRoomChat } from "./room-chat-admission";
import { nativeRoomBotGun } from "./native-room-bot-gun";
import { encodeKey } from "./identity/check";

const clock = () => Math.floor(Date.now() / 1000);
type Pilot = NonNullable<ReturnType<typeof getSquadPilotServer>>;
const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function authorityFor(pilot: Pilot, room: string, signal: AbortSignal) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const at = clock();
    const snapshot = await pilot.source.read(at, signal);
    const authority = createForumAuthority(pilot.config.authority, clock);
    const verified = await authority.refresh(snapshot, at);
    if (clock() !== at) continue;
    if (verified.ok && authority.graph.ownerOf(pilot.config.squad.forumId) === pilot.config.squad.owner &&
      !roomAuthorityDiagnosticsBlock(verified.diagnostics, snapshot, authority.graph, room)) {
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
  const pilot = getSquadPilotServer();
  if (!pilot) return;
  const callback = roomWebhookCallback(pilot.config.origin);
  if (!callback) return;
  const delivery = createRoomWebhookDelivery({
    records: createSpanopticonRecordStore({ origin, tenant, apiKey }), secret,
    async canDeliver(subscription, signal) {
      if (!await nativeRoomBotGun(pilot.config.origin).isShared(subscription.room, subscription.owner, signal)) return false;
      const { at, graph } = await authorityFor(pilot, subscription.room, signal);
      return graph.ownerOf(subscription.room) === subscription.owner &&
        graph.checkForumSee(pilot.config.squad.forumId, subscription.bot, at).allowed &&
        graph.checkForumSee(subscription.room, subscription.bot, at).allowed;
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
  return { pilot, delivery, callback };
}

export async function enqueueRoomWebhook(event: RoomWebhookEvent, signal: AbortSignal) {
  await runtime()?.delivery.enqueue(event, signal);
}

export async function roomWebhookRequest(request: Request, action: "manage" | "receive" | "inbox") {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]);
  try {
    const enabled = runtime();
    if (!enabled) return reply(503, { error: "webhooks-unavailable" });
    const { pilot, delivery, callback } = enabled;
    const origin = new URL(pilot.config.origin);
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
    const { at, graph } = await authorityFor(pilot, body.room, signal);
    const owner = session && graph.principalForKey(session.key, at);
    if (!owner || owner !== graph.ownerOf(body.room)) return reply(403, { error: "room-owner" });
    if (body.action === "list") return reply(200, { subscriptions: await delivery.list(body.room, owner, signal) });
    if (body.action === "remove" && typeof body.id === "string") {
      return reply(await delivery.remove(body.room, owner, body.id, signal) ? 200 : 404, {});
    }
    if (body.action !== "subscribe" || typeof body.bot !== "string" || !isSeaPubkey(body.bot)) return reply(400, { error: "body" });
    if (!graph.checkForumSee(pilot.config.squad.forumId, body.bot, at).allowed ||
      !graph.checkForumSee(body.room, body.bot, at).allowed) return reply(403, { error: "bot-see" });
    return reply(201, await delivery.subscribe({ room: body.room, owner, bot: body.bot, url: callback }, signal));
  } catch {
    return reply(503, { error: "webhooks-unavailable" });
  }
}

type ObservedRoom = {
  rows: Map<string, SignedRoomChat>;
  stop(): void;
};
const observed = new Map<string, ObservedRoom>();
let cursor = 0;

async function collectRoomEvents(enabled: NonNullable<ReturnType<typeof runtime>>, signal: AbortSignal) {
  const { pilot, delivery } = enabled;
  const rooms = await delivery.rooms(signal);
  const current = new Set(rooms.map(([room]) => room));
  for (const [room, watcher] of observed) {
    if (current.has(room)) continue;
    watcher.stop();
    observed.delete(room);
  }
  if (!rooms.length) return;
  const mesh = nativeRoomBotGun(pilot.config.origin);
  const [room, owner] = rooms[cursor++ % rooms.length];
  let watcher = observed.get(room);
  if (!watcher) {
    const rows = new Map<string, SignedRoomChat>();
    const stop = mesh.observe(room, (value, key) => {
      const row = snapshotRoomChatEnvelope(value);
      if (!row || row.room !== room || encodeKey(row.id) !== key) { rows.delete(key); return; }
      rows.set(key, row);
      if (rows.size > 8192) rows.delete(rows.keys().next().value!);
    });
    watcher = { rows, stop };
    observed.set(room, watcher);
    return;
  }
  if (!watcher.rows.size || !await mesh.isShared(room, owner, signal)) return;
  const { at, graph } = await authorityFor(pilot, room, signal);
  if (graph.ownerOf(room) !== owner) return;
  const admission = createRoomChatAdmission({
    graph, readerKey: () => graph.writerKey(owner, at, at), parent: pilot.config.squad.forumId, clock,
  });
  const admitted: SignedRoomChat[] = [];
  for (const [key, row] of watcher.rows) {
    signal.throwIfAborted();
    if (clock() !== at) return;
    const verified = await admission.receive(row, room, key);
    if (verified) admitted.push(verified);
  }
  for (const event of projectSharedRoomWebhookEvents(room, admitted, admission)) {
    const publishedAt = event.type === "room.message.created" ? event.message.createdAt : event.object.changedAt;
    if (publishedAt >= at - 600) await delivery.enqueue(event, signal);
  }
}

let worker: ReturnType<typeof setInterval> | undefined;
export function startRoomWebhookWorker() {
  if (worker || !process.env.S3RCH_ROOM_WEBHOOK_SIGNING_KEY) return;
  let active = false;
  worker = setInterval(() => {
    if (active) return;
    active = true;
    void Promise.resolve().then(async () => {
      const enabled = runtime();
      if (!enabled) return;
      await enabled.delivery.deliverNext(AbortSignal.timeout(9_000)).catch(() => {});
      await collectRoomEvents(enabled, AbortSignal.timeout(4_000));
    }).catch(() => {}).finally(() => { active = false; });
  }, 2_000);
  worker.unref();
}
