import { createHmac, randomUUID } from "node:crypto";
import { RecordConflict, type RecordStore } from "./record-store";
import type { RoomWebhookEvent } from "./room-webhook-events";

export type RoomWebhookSubscription = Readonly<{ id: string; room: string; owner: string; bot: string; url: string }>;
type Delivery = { subscription: string; event: RoomWebhookEvent; attempts: number; due: number; done: boolean };
type State = { version: 1; subscriptions: RoomWebhookSubscription[]; deliveries: Delivery[] };

const record = "room-webhook-delivery-v1";
const retries = [10, 60];
const attemptSeconds = 8;
const maxSubscriptions = 128;
const maxDeliveries = 512;
const retainedSeconds = 86_400;
const encode = new TextEncoder();

export function createRoomWebhookDelivery(input: {
  records: RecordStore;
  secret: string;
  clock?: () => number;
  canDeliver(subscription: RoomWebhookSubscription, signal: AbortSignal): Promise<boolean>;
  send(url: string, body: string, signature: string, signal: AbortSignal): Promise<boolean>;
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

  return {
    subscribe(data: Omit<RoomWebhookSubscription, "id">, signal: AbortSignal) {
      const subscription = { ...data, id: randomUUID() };
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
    async enqueue(event: RoomWebhookEvent, signal: AbortSignal) {
      const subscriptions = await change(signal, state => ({
        value: state.subscriptions.filter(row => row.room === event.room), changed: false,
      }));
      const allowed = new Set<string>();
      for (const subscription of subscriptions) {
        if (await input.canDeliver(subscription, signal)) allowed.add(subscription.id);
      }
      await change(signal, state => {
        const at = clock();
        state.deliveries = state.deliveries.filter(row => !row.done || row.due + retainedSeconds > at);
        const queued = new Set(state.deliveries.filter(row => row.event.id === event.id && row.event.room === event.room).map(row => row.subscription));
        const rows = state.subscriptions.filter(row => allowed.has(row.id) && !queued.has(row.id));
        if (state.deliveries.length + rows.length > maxDeliveries) throw Error("Room webhook delivery queue full");
        for (const row of rows) state.deliveries.push({ subscription: row.id, event, attempts: 0, due: at, done: false });
        return { value: undefined, changed: rows.length > 0 };
      });
    },
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
      const signature = "sha256=" + createHmac("sha256", Buffer.from(key(subscription.id), "hex")).update(body).digest("hex");
      let done = false;
      try {
        const authorized = await input.canDeliver(subscription, attemptSignal);
        attemptSignal.throwIfAborted();
        done = !authorized || await input.send(subscription.url, body, signature, attemptSignal);
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
