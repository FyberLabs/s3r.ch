import { snapshotRoomChatEnvelope, type RoomChatAdmission, type SignedRoomChat } from "./room-chat-admission";
import { encodeKey } from "./identity/check";
/** Bound both queued row count and each immutable envelope. Serialize crypto so
 * cached history bursts cannot exhaust the shared proof verifier's operation cap. */
export function createRoomChatReceiveQueue(admission: RoomChatAdmission, room: string, receive: (row: SignedRoomChat) => void, ready: () => boolean = () => true) {
  const pendingLimit = 8192, rejectedLimit = 256;
  const pending = new Map<string, SignedRoomChat>();
  const ingress = new Map<string, SignedRoomChat>();
  let ingressWorker: Promise<void> | null = null;
  const rejected = new Map<string, SignedRoomChat>();
  const deferred = new Map<string, SignedRoomChat>();
  let active = true, worker: Promise<void> | null = null;
  function retainForRetry(key: string, row: SignedRoomChat, cache = rejected) {
    cache.delete(key);
    cache.set(key, row);
    if (cache.size > rejectedLimit) cache.delete(cache.keys().next().value!);
  }
  async function drain() {
    while (active && pending.size && ready()) {
      const [key, row] = pending.entries().next().value!; pending.delete(key);
      try {
        const admitted = await admission.receive(row, room, key);
        if (!ready()) { if (!pending.has(key)) pending.set(key, row); return; }
        if (active && admitted && admission.valid(admitted)) receive(admitted);
        else if (active && !pending.has(key)) retainForRetry(key, row);
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
  async function drainIngress() {
    let batch = 0;
    while (active && ingress.size) {
      // Remove the oldest candidate before the first asynchronous operation:
      // later overflow cannot displace this in-flight verification.
      const [key, row] = ingress.entries().next().value!; ingress.delete(key);
      const authenticated = await admission.authenticateEnvelope(row);
      if (!active) return;
      if (authenticated === null) {
        if (!pending.has(key) && !rejected.has(key)) retainForRetry(key, row, deferred);
      } else if (authenticated) {
        rejected.delete(key); deferred.delete(key);
        if (!pending.has(key) && pending.size >= pendingLimit) {
          const [oldKey, oldRow] = pending.entries().next().value!;
          pending.delete(oldKey); retainForRetry(oldKey, oldRow);
        }
        pending.set(key, row);
        if (ready()) await start();
      }
      // Even cheap malformed rows yield rather than monopolizing a microtask
      // chain. P-256 work itself runs in asynchronous WebCrypto, one at a time.
      if (++batch % 16 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  function startIngress(): Promise<void> {
    ingressWorker ??= drainIngress().finally(() => {
      ingressWorker = null;
      if (active && ingress.size) startIngress();
    });
    return ingressWorker;
  }
  function enqueue(raw: unknown, key: unknown): Promise<void> {
    if (!active || typeof key !== "string") return Promise.resolve();
    const row = snapshotRoomChatEnvelope(raw);
    if (!row || row.room !== room || encodeKey(row.id) !== key) return Promise.resolve();
    // Bounded untrusted transport window, separate from authenticated work.
    // Under overflow retain fresh candidates; the in-flight oldest progresses.
    if (!ingress.has(key) && ingress.size >= pendingLimit) ingress.delete(ingress.keys().next().value!);
    ingress.set(key, row);
    return startIngress();
  }
  return {
    enqueue,
    // Revalidate refused rows only on an authority change, after queued work.
    // Pending replacements win; retained untrusted rows never bypass admission.
    resume() {
      if (!active) return Promise.resolve();
      for (const [key, row] of rejected) {
        if (pending.size >= pendingLimit - rejectedLimit) break;
        if (!pending.has(key)) pending.set(key, row);
        rejected.delete(key);
      }
      for (const [key, row] of deferred) { deferred.delete(key); void enqueue(row, key); }
      return Promise.all([pending.size && ready() ? start() : Promise.resolve(), ingressWorker]).then(() => {});
    },
    close() { active = false; pending.clear(); ingress.clear(); rejected.clear(); deferred.clear(); },
  };
}


/** Start cached-history delivery only after the first authenticated authority
 * read. Routine refreshes resume the same queue rather than resubscribing. */
export function createRoomChatSubscription(input: {
  admission: RoomChatAdmission; room: string; receive(row: SignedRoomChat): void;
  ready(): boolean;
  observeAuthority(changed: () => void): () => void;
  subscribe(receive: (row: unknown, key: unknown) => void): () => void;
}) {
  let active = true, queue: ReturnType<typeof createRoomChatReceiveQueue> | undefined;
  let stopTransport: (() => void) | undefined;
  function refresh(): Promise<void> {
    if (!active) return Promise.resolve();
    if (!queue && input.ready()) {
      queue = createRoomChatReceiveQueue(input.admission, input.room, input.receive, input.ready);
      stopTransport = input.subscribe((row, key) => { void queue?.enqueue(row, key); });
    }
    return queue?.resume() ?? Promise.resolve();
  }
  const stopAuthority = input.observeAuthority(() => { void refresh(); });
  void refresh();
  return { refresh, close() { active = false; stopAuthority(); stopTransport?.(); queue?.close(); } };
}
