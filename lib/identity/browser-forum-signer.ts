import { getMeshKey, isPlaintextMeshKeyRecord, type MeshKeyRecord } from "./idb";
import { isSeaPubkey } from "./forum-check";
import type { SeaPair } from "./sea";
import { readUnlockedMeshPair, rememberUnlockedMeshPair, subscribeUnlockedMeshPair } from "./unlocked-mesh";
import { signForumRecord } from "../forum-sign";
import { publishForumAuthorized } from "../forum-authorized-publish";

type Sources = {
  read: (address: string) => Promise<MeshKeyRecord | null>;
  unlocked: (address: string) => SeaPair | null;
  remember: (address: string, pair: SeaPair) => void;
  subscribe: (listener: (address: string, pair: SeaPair | null) => void) => () => void;
};
const sources: Sources = { read: getMeshKey, unlocked: readUnlockedMeshPair,
  remember: rememberUnlockedMeshPair, subscribe: subscribeUnlockedMeshPair };

/** Browser key loading only; a held key is never a destination grant. */
export function observeBrowserForumSigner(address: string | null, permitted: (pub: string) => boolean,
  changed: (pub: string | null) => void, source: Sources = sources) {
  let pair: SeaPair | null = null, stopped = false, revision = 0;
  changed(null);
  const readable = (pub: string | null | undefined): pub is string => !!pub && isSeaPubkey(pub) && permitted(pub);
  const hold = (candidate: SeaPair | null, hint: string | null) => {
    if (stopped) return;
    pair = null;
    if ((candidate && !readable(candidate.pub)) || (hint && !readable(hint))) { changed(null); return; }
    if (candidate && (!hint || candidate.pub === hint)) { pair = candidate; changed(pair.pub); return; }
    const held = address ? source.unlocked(address) : null;
    if (hint && readable(hint)) {
      pair = held?.pub === hint ? held : null;
      changed(hint);
    } else changed(null);
  };
  let unsubscribe = () => {};
  if (address) {
    unsubscribe = source.subscribe((heard, next) => {
      if (heard !== address.trim().toLowerCase() || stopped) return;
      revision++;
      hold(next, next?.pub ?? null);
    });
    const remembered = source.unlocked(address);
    if (remembered) hold(remembered, remembered.pub);
    const initial = revision;
    void Promise.resolve().then(() => source.read(address)).then(record => {
      // A lock, unlock or replacement wins over any earlier disk read.
      if (stopped || revision !== initial) return;
      const pub = readable(record?.seaPub) ? record!.seaPub : null;
      if (record && isPlaintextMeshKeyRecord(record) && record.seaPair.pub === pub) {
        source.remember(address, record.seaPair);
        if (!stopped && revision === initial) hold(source.unlocked(address), pub);
      } else hold(source.unlocked(address), pub);
    }).catch(() => {
      if (!stopped && revision === initial) { pair = null; changed(null); }
    });
  }
  return Object.freeze({ current: () => stopped ? null : pair,
    stop() { if (stopped) return; stopped = true; pair = null; unsubscribe(); },
  });
}

/** A signature does not preserve authority across an asynchronous operation. */
export async function publishBrowserForumRecord<T extends object>(input: {
  live: boolean; record: T; writer: string; pair: () => SeaPair | null;
  writerKey: (writer: string, now: number) => string | null; authorized: () => boolean;
  put: (record: T & { sig: string }) => boolean | Promise<boolean>;
  sign?: (record: T, pair: SeaPair) => Promise<string | null>;
}): Promise<"signed" | "offline" | "local" | "denied"> {
  if (!input.live) return "local";
  const pair = input.pair();
  if (!pair || input.writerKey(input.writer, Math.floor(Date.now() / 1000)) !== pair.pub) return "local";
  return publishForumAuthorized({ record: input.record,
    authorized: () => input.authorized() && input.pair() === pair &&
      input.writerKey(input.writer, Math.floor(Date.now() / 1000)) === pair.pub,
    sign: value => (input.sign ?? signForumRecord)(value, pair), put: input.put });
}
