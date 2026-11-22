import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { RecordConflict, type RecordStore } from "./record-store";
import type { RoomWebhookEvent } from "./room-webhook-events";

export type RoomWebhookSubscription = Readonly<{ id: string; room: string; owner: string; bot: string; url: string; createdAt: number }>;
type Delivery = { subscription: string; event: RoomWebhookEvent; attempts: number; due: number; done: boolean; received?: boolean };
type State = { version: 1; subscriptions: RoomWebhookSubscription[]; deliveries: Delivery[] };

const record = "room-webhook-delivery-v1";
const retries = [10, 60];
const attemptSeconds = 8;
const maxSubscriptions = 128;
const maxPending = 512;
const maxReceipts = 4096;
const retainedSeconds = 86_400;
const encode = new TextEncoder();

export function createRoomWebhookDelivery(input: {
  records: RecordStore;
  secret: string;
  clock?: () => number;
  canDeliver(subscription: RoomWebhookSubscription, signal: AbortSignal): Promise<boolean>;
  send(subscription: RoomWebhookSubscription, body: string, signature: string, signal: AbortSignal): Promise<boolean>;
}) {
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  async function change<T>(signal: AbortSignal, edit: (state: State) => { value: T; changed: boolean }): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      signal.throwIfAborted();
      const saved = await input.records.get("recovery", record, signal);
      const state: State = saved
        ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(saved.bytes))
        : { version: 1, subscriptions: [], deliveries: [] };
      if (state.version !== 1 || !Array.isArray(state.subscriptions) || !Array.isArray(state.deliveries)) {
        throw Error("Invalid room webhook store");
      }
      const result = edit(state);
      if (!result.changed) return result.value;
      try {
        await input.records.put("recovery", record, encode.encode(JSON.stringify(state)), saved?.revision ?? null, signal);
        return result.value;
      } catch (error) {
        if (!(error instanceof RecordConflict)) throw error;
      }
    }
    throw Error("Room webhook update conflicted");
  }
  const key = (id: string) => createHmac("sha256", input.secret).update("s3rch-room-webhook/v1\n" + id).digest("hex");

  const sign = (id: string, body: string) =>
    "sha256=" + createHmac("sha256", Buffer.from(key(id), "hex")).update(body).digest("hex");

  async function enqueueRoom(room: string, events: readonly RoomWebhookEvent[], signal: AbortSignal) {
    if (!events.length) return;
    const eventTime = (event: RoomWebhookEvent) =>
      event.type === "room.message.created" ? event.message.createdAt : event.object.changedAt;
    const matches = (event: RoomWebhookEvent, sub: RoomWebhookSubscription) =>
      event.room === room && sub.room === room && sub.createdAt <= eventTime(event);
    const queued = (rows: Delivery[], room: string) => new Set(rows.filter(row => row.event.room === room)
      .map(row => row.subscription + ":" + row.event.id));
    const candidates = await change(signal, state => {
      const existing = queued(state.deliveries, room);
      return { changed: false, value: state.subscriptions.filter(sub =>
        events.some(event => matches(event, sub) && !existing.has(sub.id + ":" + event.id))) };
    });
    const allowed = new Set<string>();
    for (const subscription of candidates) {
      if (await input.canDeliver(subscription, signal)) allowed.add(subscription.id);
    }
    if (!allowed.size) return;
    await change(signal, state => {
      const at = clock();
      const pending = state.deliveries.filter(row => !row.done);
      const receipts = state.deliveries.filter(row => row.done && row.due + retainedSeconds > at).slice(-maxReceipts);
      state.deliveries = [...pending, ...receipts];
      const existing = queued(state.deliveries, room);
      let remaining = maxPending - pending.length;
      let changed = false;
      for (const sub of state.subscriptions) {
        if (!allowed.has(sub.id)) continue;
        for (const event of events) {
          if (remaining <= 0) return { changed, value: undefined };
          const id = sub.id + ":" + event.id;
          if (!matches(event, sub) || existing.has(id)) continue;
          state.deliveries.push({ subscription: sub.id, event, attempts: 0, due: at, done: false });
          existing.add(id);
          remaining--;
          changed = true;
        }
      }
      return { changed, value: undefined };
    });
  }

  return {
    receive(id: string, body: string, signature: string, signal: AbortSignal) {
      if (!/^sha256=[0-9a-f]{64}$/.test(signature) ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(sign(id, body)))) return Promise.resolve(false);
      return change(signal, state => {
        const row = state.deliveries.find(item => item.subscription === id && JSON.stringify(item.event) === body);
        if (!row) return { changed: false, value: false };
        if (row.received) return { changed: false, value: true };
        row.received = true;
        return { changed: true, value: true };
      });
    },
    async inbox(id: string, bot: string, signal: AbortSignal) {
      const subscription = await change(signal, state => ({
        changed: false, value: state.subscriptions.find(row => row.id === id && row.bot === bot),
      }));
      if (!subscription || !await input.canDeliver(subscription, signal)) return null;
      return change(signal, state => ({
        changed: false, value: state.deliveries.filter(row => row.subscription === id && row.received).map(row => row.event),
      }));
    },
    subscribe(data: Omit<RoomWebhookSubscription, "id" | "createdAt">, signal: AbortSignal) {
      const subscription = { ...data, id: randomUUID(), createdAt: clock() };
      return change(signal, state => {
        if (state.subscriptions.length >= maxSubscriptions) throw Error("Room webhook subscriptions full");
        state.subscriptions.push(subscription);
        return { changed: true, value: { subscription, signingKey: key(subscription.id) } };
      });
    },
    remove(room: string, owner: string, id: string, signal: AbortSignal) {
      return change(signal, state => {
        const index = state.subscriptions.findIndex(row => row.id === id && row.room === room && row.owner === owner);
        if (index < 0) return { value: false, changed: false };
        state.subscriptions.splice(index, 1);
        state.deliveries = state.deliveries.filter(row => row.subscription !== id);
        return { value: true, changed: true };
      });
    },
    list(room: string, owner: string, signal: AbortSignal) {
      return change(signal, state => ({
        value: state.subscriptions.filter(row => row.room === room && row.owner === owner), changed: false,
      }));
    },
    rooms(signal: AbortSignal) {
      return change(signal, state => ({
        changed: false, value: [...new Map(state.subscriptions.map(row => [row.room, row.owner]))],
      }));
    },
    enqueueRoom,
    async deliverNext(signal: AbortSignal) {
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(attemptSeconds * 1000)]);
      const claimed = await change(attemptSignal, state => {
        const at = clock();
        const row = state.deliveries.find(delivery => !delivery.done && delivery.due <= at);
        const subscription = row && state.subscriptions.find(sub => sub.id === row.subscription);
        if (!row || !subscription) return { value: null, changed: false };
        if (row.attempts >= retries.length + 1) {
          row.done = true;
          row.due = at;
          return { value: null, changed: true };
        }
        // Advance the attempt before I/O so multiple workers cannot claim it.
        row.due = at + attemptSeconds + 1;
        row.attempts += 1;
        return { value: { ...row, subscription }, changed: true };
      });
      if (!claimed) return false;
      const { subscription, event, attempts } = claimed;
      const body = JSON.stringify(event);
      const signature = sign(subscription.id, body);
      let done = false;
      try {
        const authorized = await input.canDeliver(subscription, attemptSignal);
        attemptSignal.throwIfAborted();
        done = !authorized || await input.send(subscription, body, signature, attemptSignal);
      } catch {
        // Worker interruption and transient authority failures consume this attempt.
      }
      await change(signal, state => {
        const row = state.deliveries.find(item => item.event.id === event.id && item.event.room === event.room && item.subscription === subscription.id);
        if (!row || row.attempts !== attempts) return { value: undefined, changed: false };
        row.done = done || attempts > retries.length;
        row.due = clock() + (row.done ? 0 : retries[attempts - 1]);
        return { value: undefined, changed: true };
      });
      return true;
    },
  };
}
