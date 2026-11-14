import { snapshotRoomChatEnvelope, type RoomChatAdmission, type SignedRoomChat } from "./room-chat-admission";
import { encodeKey } from "./identity/check";
/** Bound both queued row count and each immutable envelope. Serialize crypto so
 * cached history bursts cannot exhaust the shared proof verifier's operation cap. */
export function createRoomChatReceiveQueue(admission: RoomChatAdmission, room: string, receive: (row: SignedRoomChat) => void, ready: () => boolean = () => true) {
  const pending = new Map<string, SignedRoomChat>();
  let active = true, worker: Promise<void> | null = null;
  async function drain() {
    while (active && pending.size && ready()) {
      const [key, row] = pending.entries().next().value!; pending.delete(key);
      try {
        const admitted = await admission.receive(row, room, key);
        if (!ready()) { if (!pending.has(key)) pending.set(key, row); return; }
        if (active && admitted && admission.valid(admitted)) receive(admitted);
      } catch { /* A malformed row cannot prevent later queued rows being checked. */ }
    }
  }
  function start(): Promise<void> {
    worker ??= Promise.resolve().then(drain).finally(() => {
      worker = null;
      if (active && pending.size && ready()) start();
    });
    return worker;
  }
  return {
    enqueue(raw: unknown, key: unknown): Promise<void> {
      if (!active || typeof key !== "string") return Promise.resolve();
      const row = snapshotRoomChatEnvelope(raw);
      if (!row || row.room !== room || encodeKey(row.id) !== key || (!pending.has(key) && pending.size >= 8192)) return Promise.resolve();
      pending.set(key, row);
      return ready() ? start() : Promise.resolve();
    },
    resume() { if (active && pending.size && ready()) return start(); return Promise.resolve(); },
    close() { active = false; pending.clear(); },
  };
}
