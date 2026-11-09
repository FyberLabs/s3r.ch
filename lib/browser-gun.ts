import type { FeedGun } from "@/components/GunPeerProvider";
import { browserGunOptions, listenThenConnectSeedPeer, type SeedPeerEmitter } from "./gun-peer";
import { attachGunWebrtcLib } from "./gun-webrtc";
import { fetchTurnAllocate, rtcOptionsFromAllocation, startTurnIceRefresh } from "./turn-ice";

type Subscription = { off(): void };
type Callback = (data: unknown, key: string) => void;
type Graph = {
  _: { root: { once: number }; any?: Record<string, Subscription & { id: number }> };
  get(key: string): Graph;
  map(): Graph;
  put(value: unknown): Graph;
  on(callback: (data: unknown, key: string, message: unknown, event: Subscription) => void): Graph;
};
type Peer = { defer?: ReturnType<typeof setTimeout>; wire?: { close(): void }; close?(): void };
type Root = Graph & SeedPeerEmitter & { _: { opt: { peers: Record<string, Peer> } } };

// Gun returns the entire chain from on(). Its off() also removes other readers.
// Use the fourth callback argument to unsubscribe just this registration.
function scopedGraph(root: Graph, lifetime: AbortSignal): FeedGun {
  function wrap(chain: Graph): FeedGun & { on(callback: Callback): Subscription } {
    function subscribe(callback: Callback) {
      let notify: Callback | undefined = callback;
      let event: Subscription | undefined;
      // In pinned Gun, get.js assigns ++root.once to this on() registration
      // before emitting its first read. Empty nodes may never deliver an event.
      const registrationId = chain._.root.once + 1;
      function off() {
        if (!notify) return;
        notify = undefined;
        const registration = event ?? Object.values(chain._.any ?? {}).find(item => item.id === registrationId);
        registration?.off();
        lifetime.removeEventListener("abort", off);
      }
      if (!lifetime.aborted) {
        lifetime.addEventListener("abort", off);
        chain.on((data, key, _msg, registration) => {
          event = registration;
          if (notify) notify(data, key);
          else registration.off();
        });
      }
      return { off };
    }
    return {
      get: key => wrap(chain.get(key)),
      map: () => wrap(chain.map()),
      put(value) {
        if (lifetime.aborted) throw new Error("Gun connection released");
        chain.put(value);
        return this;
      },
      on: subscribe,
    };
  }
  return wrap(root);
}

async function openBrowserGun(origin: string, turnAccount: string, signal: AbortSignal, status: (up: boolean) => void) {
  const module = await import("gun/browser");
  signal.throwIfAborted();
  const Gun = (module.default ?? module) as unknown as (opts: object) => Root;
  const allocate = () => fetchTurnAllocate((input, init) => fetch(input, { ...init, signal }));
  const allocation = turnAccount ? await allocate() : null;
  signal.throwIfAborted();
  await attachGunWebrtcLib(Gun);
  signal.throwIfAborted();
  const rtc = rtcOptionsFromAllocation(allocation);
  const connections = new Set<RTCPeerConnection>();
  const root = Gun({
    ...browserGunOptions(undefined, rtc),
    // Gun can retry after a hidden-tab timer wakes, even after it loses its peer.
    WebSocket: class extends WebSocket {
      constructor(url: string) {
        signal.throwIfAborted();
        super(url);
      }
    },
    RTCPeerConnection: typeof RTCPeerConnection === "undefined" ? false : class extends RTCPeerConnection {
      constructor(config: RTCConfiguration) {
        signal.throwIfAborted();
        super(config);
        connections.add(this);
      }
      close() {
        connections.delete(this);
        super.close();
      }
    },
  });
  const refresh = startTurnIceRefresh({ rtc, expiresAt: allocation?.expiresAt ?? null, fetchAllocate: allocate });
  signal.addEventListener("abort", () => {
    refresh.stop();
    const peers = root._.opt.peers;
    for (const [key, peer] of Object.entries(peers)) {
      delete peers[key];
      clearTimeout(peer.defer);
      peer.wire?.close();
      peer.close?.();
    }
    for (const connection of connections) connection.close();
  }, { once: true });
  listenThenConnectSeedPeer(root, origin, status);
  return root;
}

export function createBrowserGunPool(open: typeof openBrowserGun) {
  type Entry = {
    controller: AbortController;
    listeners: Set<(up: boolean) => void>;
    ready: Promise<Root>;
    up: boolean;
  };
  const entries = new Map<string, Entry>();
  return function acquire(origin: string, turnAccount = "") {
    const key = JSON.stringify([origin, turnAccount]);
    let entry = entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      const listeners = new Set<(up: boolean) => void>();
      const current: Entry = {
        controller, listeners, up: false,
        ready: Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return open(origin, turnAccount, controller.signal, up => {
            current.up = up;
            for (const notify of listeners) notify(up);
          });
        }),
      };
      entry = current;
      entries.set(key, current);
    }
    const shared = entry;
    const lifetime = new AbortController();
    let listener: ((up: boolean) => void) | undefined;
    const release = () => {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      shared.listeners.delete(notify);
      if (!shared.listeners.size) {
        entries.delete(key);
        shared.controller.abort();
      }
    };
    const notify = (up: boolean) => listener?.(up);
    shared.listeners.add(notify);
    return {
      ready: shared.ready.then(root => {
        lifetime.signal.throwIfAborted();
        return scopedGraph(root, lifetime.signal);
      }).catch(error => { release(); throw error; }),
      onStatus(callback: (up: boolean) => void) {
        if (lifetime.signal.aborted) return;
        listener = callback;
        notify(shared.up);
      },
      release,
    };
  };
}

export const acquireBrowserGun = createBrowserGunPool(openBrowserGun);
