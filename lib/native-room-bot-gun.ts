import { encodeKey } from "./identity/check";
import { sameOriginGunPeerUrl } from "./gun-peer";
import { fromGunRoomNode } from "./rooms";
import type { SignedRoomChat } from "./room-chat-admission";

type GunRef = {
  get(key: string): GunRef;
  map(): { on(callback: (value: unknown, key: string, at: unknown, event: { off(): void }) => void): void };
  once(callback: (value: Record<string, unknown> | undefined) => void): void;
  put(value: SignedRoomChat, callback: (ack: { err?: unknown }) => void): void;
};

let peer: { url: string; root: GunRef } | undefined;

function roomRef(origin: string, room: string) {
  const url = sameOriginGunPeerUrl(origin);
  if (!peer || peer.url !== url) {
    // Gun stays external to the Next.js bundle and connects only when used.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Gun = require("gun") as (options: Record<string, unknown>) => GunRef;
    peer = { url, root: Gun({ peers: [url], radisk: false, localStorage: false, multicast: false, axe: false }) };
  }
  return peer.root.get("s3rch").get("rooms").get(encodeKey(room));
}

function withGunAck<T>(signal: AbortSignal, start: (resolve: (value: T) => void, reject: (error: unknown) => void) => void) {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  return new Promise<T>((resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    start(resolve, reject);
  }).finally(() => signal.removeEventListener("abort", onAbort));
}

export function nativeRoomBotGun(origin: string) {
  return {
    async isShared(room: string, owner: string, signal: AbortSignal) {
      const row = await withGunAck<Record<string, unknown> | undefined>(signal, resolve => roomRef(origin, room).once(resolve));
      const shared = fromGunRoomNode(row);
      return shared?.id === room && shared.owner === owner;
    },
    observe(room: string, receive: (value: unknown, key: string) => void) {
      let active = true;
      let listener: { off(): void } | undefined;
      roomRef(origin, room).get("chat").map().on((value, key, _at, event) => {
        if (!active) { event.off(); return; }
        listener = event;
        receive(value, key);
      });
      return () => { active = false; listener?.off(); };
    },
    publish(message: SignedRoomChat, signal: AbortSignal) {
      return withGunAck<void>(signal, (resolve, reject) => {
        roomRef(origin, message.room).get("chat").get(encodeKey(message.id)).put(message, ack => {
          if (ack?.err || !ack) reject(Error("Room peer refused reply"));
          else resolve();
        });
      });
    },
  };
}
