import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { RecordConflict, type RecordStore, type StoredRecord } from "./record-store";
import { createRoomWebhookDelivery, type RoomWebhookSubscription } from "./room-webhook-delivery";
import { roomMessageWebhookEvent } from "./room-webhook-events";

test("room webhook delivery checks access, signs each event, and bounds retries", async () => {
  const signal = new AbortController().signal;
  const messages: { payload: string; signature: string }[] = [];
  const visible = new Set(["allowed"]);
  let revision = 0;
  let stored: StoredRecord | null = null;
  const records: RecordStore = {
    get: async () => stored,
    async put(_namespace, _name, bytes, expected) {
      if (expected !== (stored?.revision ?? null)) throw new RecordConflict();
      stored = { bytes, revision: String(++revision) };
      return stored.revision;
    },
    async delete() { assert.fail("delivery does not delete the registry"); },
  };
  let at = 100;
  const adapters = {
    records, secret: "synthetic-room-webhook-fixture".repeat(2), clock: () => at,
    canDeliver: async ({ bot }: { bot: string }) => visible.has(bot),
    send: async (_subscription: RoomWebhookSubscription, payload: string, signature: string) => {
      messages.push({ payload, signature });
      return false;
    },
  };
  const queue = createRoomWebhookDelivery(adapters);
  const worker = createRoomWebhookDelivery(adapters);
  const room = "fixture-room", owner = "fixture-owner";
  const callback = "https://callback.example.test/room";
  const { signingKey, subscription } = await queue.subscribe({ room, owner, bot: "allowed", url: callback }, signal);
  await queue.subscribe({ room, owner, bot: "denied", url: callback }, signal);
  assert.equal((await queue.list(room, "different-owner", signal)).length, 0);
  const message = {
    id: "fixture-message", room, author: "fixture-agent", body: "fixture message",
    ts: at,
  };
  await queue.enqueueRoom(room, [roomMessageWebhookEvent(message)], signal);
  await queue.enqueueRoom(room, [roomMessageWebhookEvent(message)], signal);
  assert.equal(await worker.deliverNext(signal), true);
  assert.equal(await worker.deliverNext(signal), false);
  const signed = messages[0];
  const verify = (body: string) =>
    "sha256=" + createHmac("sha256", Buffer.from(signingKey, "hex")).update(body).digest("hex");
  assert.equal(signed.signature, verify(signed.payload));
  assert.notEqual(signed.signature, verify(signed.payload + " "));
  assert.equal(JSON.parse(signed.payload).type, "room.message.created");
  assert.equal(await queue.receive(subscription.id, signed.payload + " ", signed.signature, signal), false);
  assert.equal(await queue.receive(subscription.id, signed.payload, signed.signature, signal), true);
  assert.equal(await queue.receive(subscription.id, signed.payload, signed.signature, signal), true);
  assert.equal((await queue.inbox(subscription.id, "allowed", signal))?.length, 1);
  assert.equal(await queue.inbox(subscription.id, "denied", signal), null);
  at += 10;
  assert.equal(await worker.deliverNext(signal), true);
  at += 60;
  assert.equal(await worker.deliverNext(signal), true);
  at += 60;
  assert.equal(await worker.deliverNext(signal), false);
  assert.equal(messages.length, 3);

  await queue.enqueueRoom(room, [roomMessageWebhookEvent({ ...message, id: "another" })], signal);
  visible.clear();
  assert.equal(await worker.deliverNext(signal), true);
  assert.equal(messages.length, 3);
});
